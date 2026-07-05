'use strict';

/**
 * ============================================================================
 *  MAFIA ONLINE - server.js  (نسخه‌ی ۲: دفاعیه + نقش‌های جدید)
 * ============================================================================
 *
 *  سرور کامل بازی مافیای آنلاین: مدیریت اتاق‌های خصوصی، بازیکنان، نقش‌ها،
 *  فازهای بازی (لابی -> شب -> روز -> رأی‌گیری -> [دفاعیه] -> رأی‌گیری نهایی
 *  -> پایان)، رأی‌گیری امن سمت سرور، بررسی شرط برد، و signaling کامل WebRTC
 *  برای ویس زنده داخل اتاق (شامل کانال خصوصی شبانه‌ی مافیا).
 *
 *  تکنولوژی: Node.js + Express + Socket.IO
 *  ویس: WebRTC (mesh peer-to-peer) - سرور فقط signaling را انجام می‌دهد،
 *       صدای خام هرگز از سرور عبور نمی‌کند.
 *
 * ----------------------------------------------------------------------------
 *  قرارداد Eventها (Event Contract) - این بخش باید عیناً با client.js هماهنگ
 *  باشد. هر تغییری در نام event یا شکل payload باید همزمان در هر دو فایل
 *  اعمال شود تا mismatch ایجاد نشود.
 * ----------------------------------------------------------------------------
 *
 *  === Client -> Server ===
 *  join_room            { username, roomName }
 *  toggle_ready          {}                                  (پیش از شروع بازی)
 *  update_room_settings  { rolesConfig }                       (فقط host)
 *  start_game             {}                                  (فقط host)
 *  acknowledge_role       {}                                  (تأیید دیدن نقش خصوصی)
 *  night_action           { targetId }                        (نقش‌های دارای اکشن شبانه)
 *  force_resolve_night    {}                                  (فقط host - رزولوشن دستی شب)
 *  advance_to_voting      {}                                  (فقط host - روز -> رأی‌گیری)
 *  day_vote               { targetId | null }                 (null = رأی سفید/عدم رأی)
 *  end_voting             {}                                  (فقط host - پایان دستی دور رأی‌گیری)
 *  end_defense             {}                                  (فقط host - پایان زودهنگام دفاعیه)
 *  play_again              {}                                  (فقط host - ریست به لابی)
 *  leave_room              {}
 *
 *  === Voice / WebRTC (Client -> Server، صرفاً signaling relay) ===
 *  voice_join              {}
 *  voice_leave              {}
 *  voice_offer               { targetId, sdp }
 *  voice_answer               { targetId, sdp }
 *  voice_ice_candidate         { targetId, candidate }
 *  voice_toggle_mute             { isMuted }
 *  voice_speaking                 { isSpeaking }
 *
 *  === Server -> Client ===
 *  join_error                { message }
 *  joined_room                { room, you }        (پس از join موفق)
 *  room_state                 { room }             (broadcast هر تغییر state عمومی؛ در فاز شب per-socket و ماسک‌شده برای غیرمافیا - نگاه کنید به broadcastRoomState)
 *  system_message              { text, ts }
 *  start_game_error             { message }
 *  your_role                     { role, team, description, displayName, bulletsRemaining? }  (private)
 *  mafia_teammates                 { teammates: [{id, username, role}] }  (private، فقط تیم مافیا، ابتدای هر شب)
 *  phase_changed                    { phase, dayNumber }   (phase یکی از: lobby/role_reveal/night/day/voting/defense/results/ended)
 *  night_action_ack                  { message }
 *  night_action_error                 { message }
 *  detective_result                    { targetId, targetUsername, team }  (private)
 *  saqi_effect                          { message }         (private، فقط به فرد مست‌شده)
 *  night_result                          { deaths: [{id, username, cause}], noDeath }
 *  vote_update                            { votes, tally }
 *  vote_error                              { message }
 *  defense_started                          { defendantId, defendantUsername, durationMs }
 *  defense_ended                             {}
 *  voting_result                              { eliminated: {id, username} | null, tie, wentToDefense }
 *  game_over                                   { winner, reason, roles }
 *  reset_to_lobby                               { room }
 *
 *  === Voice / WebRTC (Server -> Client) ===
 *  voice_peer_joined            { peerId }
 *  voice_peer_left               { peerId }
 *  voice_offer                     { fromId, sdp }
 *  voice_answer                     { fromId, sdp }
 *  voice_ice_candidate                { fromId, candidate }
 *  voice_mute_state                     { peerId, isMuted }
 *
 * ============================================================================
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------------
// ثابت‌ها (Constants)
// ----------------------------------------------------------------------------

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  ROLE_REVEAL: 'role_reveal',
  NIGHT: 'night',
  DAY: 'day',
  VOTING: 'voting',
  DEFENSE: 'defense',
  RESULTS: 'results',
  ENDED: 'ended',
});

const TEAMS = Object.freeze({
  MAFIA: 'mafia',
  CITIZEN: 'citizen',
});

const DEFENSE_DURATION_MS = 75000; // ۷۵ ثانیه دفاعیه

/**
 * تعریف نقش‌ها. اضافه‌کردن نقش جدید در آینده فقط نیازمند یک entry جدید اینجا
 * و (در صورت داشتن منطق اختصاصی شب) چند خط در resolveNightActions است.
 */
const ROLE_DEFINITIONS = Object.freeze({
  mafia_boss: {
    key: 'mafia_boss',
    displayName: 'رئیس مافیا',
    team: TEAMS.MAFIA,
    hasNightAction: true,
    description: 'هر شب هدف نهایی برای حذف را شخصاً تعیین می‌کنید؛ تا وقتی زنده‌اید، تصمیم شما همیشه نهایی است.',
    maxUses: null,
  },
  mafia: {
    key: 'mafia',
    displayName: 'مافیای ساده',
    team: TEAMS.MAFIA,
    hasNightAction: true,
    description:
      'عضو تیم مافیا هستید. اگر رئیس مافیا زنده باشد، تصمیم نهایی با اوست و شما فقط با تیم گفت‌وگو می‌کنید؛ اگر رئیس نباشد، هدف با اجماع خودتان تعیین می‌شود.',
    maxUses: null,
  },
  doctor_lecter: {
    key: 'doctor_lecter',
    displayName: 'دکتر لکتر',
    team: TEAMS.MAFIA,
    hasNightAction: true,
    description: 'عضو مخفی تیم مافیا هستید؛ هر شب می‌توانید یکی از هم‌تیمی‌های مافیا (یا خودتان) را در برابر شلیک تک‌تیرانداز محافظت کنید.',
    maxUses: null,
  },
  doctor: {
    key: 'doctor',
    displayName: 'دکتر',
    team: TEAMS.CITIZEN,
    hasNightAction: true,
    description: 'هر شب می‌توانید یک نفر (از جمله خودتان) را از حذف نجات دهید.',
    maxUses: null,
  },
  detective: {
    key: 'detective',
    displayName: 'کارآگاه',
    team: TEAMS.CITIZEN,
    hasNightAction: true,
    description: 'هر شب می‌توانید تیم یک نفر را استعلام بگیرید.',
    maxUses: null,
  },
  saqi: {
    key: 'saqi',
    displayName: 'ساقی',
    team: TEAMS.CITIZEN,
    hasNightAction: true,
    description: 'هر شب یک نفر را مست می‌کنید؛ آن فرد در همان شب نمی‌تواند اکشن خودش را انجام دهد.',
    maxUses: null,
  },
  natasha: {
    key: 'natasha',
    displayName: 'ناتاشا',
    team: TEAMS.CITIZEN,
    hasNightAction: true,
    description: 'مثل یک روان‌پزشک، هر شب یک نفر را سایلنت می‌کنید؛ آن فرد روز بعد نمی‌تواند صحبت کند.',
    maxUses: null,
  },
  sniper: {
    key: 'sniper',
    displayName: 'تک‌تیرانداز',
    team: TEAMS.CITIZEN,
    hasNightAction: true,
    description: 'شما ۲ تیر دارید. اگر به یک مافیا شلیک کنید حذفش می‌کنید؛ اگر اشتباه بزنید (هدف مافیا نباشد)، خودتان از بازی حذف می‌شوید.',
    maxUses: 2,
  },
  citizen: {
    key: 'citizen',
    displayName: 'شهروند',
    team: TEAMS.CITIZEN,
    hasNightAction: false,
    description: 'در طول روز با بحث و رأی‌گیری به مافیا مشکوک می‌شوید.',
    maxUses: null,
  },
});

const VALIDATION = Object.freeze({
  MIN_USERNAME_LEN: 2,
  MAX_USERNAME_LEN: 20,
  MIN_ROOMNAME_LEN: 2,
  MAX_ROOMNAME_LEN: 30,
  MIN_PLAYERS_TO_START: 4,
  MAX_PLAYERS_PER_ROOM: 20,
});

// ----------------------------------------------------------------------------
// حافظه‌ی داخلی (In-memory store)
// ----------------------------------------------------------------------------

/** @type {Map<string, Room>} roomId(lowercase) -> Room */
const rooms = new Map();

/** @type {Map<string, string>} socketId -> roomId(lowercase) */
const socketRoomIndex = new Map();

// ----------------------------------------------------------------------------
// توابع کمکی عمومی
// ----------------------------------------------------------------------------

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, maxLen);
}

function isNonEmpty(str) {
  return typeof str === 'string' && str.trim().length > 0;
}

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function roomKey(roomName) {
  return sanitizeText(roomName, VALIDATION.MAX_ROOMNAME_LEN).toLowerCase();
}

/** از یک Map(id -> count) بیشترین را برمی‌گرداند؛ در تساوی، یکی تصادفی. خالی -> null. */
function pickMaxFromTally(tally) {
  if (tally.size === 0) return null;
  let max = -1;
  let candidates = [];
  for (const [id, count] of tally.entries()) {
    if (count > max) {
      max = count;
      candidates = [id];
    } else if (count === max) {
      candidates.push(id);
    }
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ----------------------------------------------------------------------------
// مدل داده: Room و Player
// ----------------------------------------------------------------------------

function createPlayer(id, username, roomId, isHost) {
  return {
    id,
    username,
    roomId,
    isHost,
    isReady: isHost,
    isAlive: true,
    role: null,
    isMuted: false,
    connected: true,
    inVoice: false,
    sniperBulletsRemaining: null,
    joinedAt: Date.now(),
  };
}

function createRoom(displayName) {
  const key = roomKey(displayName);
  return {
    id: displayName,
    key,
    players: new Map(),
    hostId: null,
    phase: PHASES.LOBBY,
    dayNumber: 0,
    rolesConfig: null,
    nightActions: freshNightActions(),
    votes: new Map(),
    votingRound: 1,
    defendantId: null,
    silencedPlayerId: null,
    winner: null,
    _defenseTimer: null,
    createdAt: Date.now(),
  };
}

function freshNightActions() {
  return {
    mafiaTargets: new Map(), // fallback consensus بین مافیای ساده (فقط وقتی رئیس زنده نیست)
    bossTarget: null,
    bossActedBy: null,
    doctorSave: null,
    doctorActedBy: null,
    detectiveCheck: null,
    detectiveActedBy: null,
    saqiTarget: null,
    saqiActedBy: null,
    natashaTarget: null,
    natashaActedBy: null,
    lecterProtect: null,
    lecterActedBy: null,
    sniperShots: new Map(), // shooterId -> targetId
    sniperActedIds: new Set(),
  };
}

function getRoom(key) {
  return rooms.get(key) || null;
}

function getPlayer(room, socketId) {
  return room ? room.players.get(socketId) || null : null;
}

function alivePlayers(room) {
  return Array.from(room.players.values()).filter((p) => p.isAlive);
}

function connectedPlayers(room) {
  return Array.from(room.players.values()).filter((p) => p.connected);
}

// ----------------------------------------------------------------------------
// سریال‌سازی state برای ارسال به کلاینت
// ----------------------------------------------------------------------------

function serializeRoomPublic(room) {
  const revealRoles = room.phase === PHASES.ENDED;
  return {
    id: room.id,
    phase: room.phase,
    dayNumber: room.dayNumber,
    hostId: room.hostId,
    winner: room.winner,
    rolesConfig: room.rolesConfig,
    defendantId: room.defendantId,
    silencedPlayerId: room.silencedPlayerId,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      username: p.username,
      isHost: p.isHost,
      isReady: p.isReady,
      isAlive: p.isAlive,
      isMuted: p.isMuted,
      connected: p.connected,
      inVoice: p.inVoice,
      sniperBulletsRemaining: p.sniperBulletsRemaining,
      role: revealRoles ? p.role : undefined,
    })),
  };
}

/** آیا نقش داده‌شده عضو تیم مافیاست؟ (کمکی برای تصمیم‌گیری‌های دیدِ محدود شبانه) */
function isMafiaTeamRole(role) {
  return ROLE_DEFINITIONS[role]?.team === TEAMS.MAFIA;
}

/**
 * وضعیت اتاق را broadcast می‌کند. در فاز شب، برای جلوگیری از لو رفتن هویت
 * مافیا از طریق «کی میکروفونش بازه»، دو نسخه از room_state ساخته می‌شود:
 * نسخه‌ی واقعی فقط برای اعضای تیم مافیا (که همدیگر را می‌شناسند) و یک نسخه‌ی
 * ماسک‌شده (isMuted همه true) برای بقیه، تا از دید آن‌ها همه ساکت به نظر برسند.
 * در سایر فازها (که سکوت/صحبت علنی و بدون رازداری است) یک broadcast عمومی کافی است.
 */
function broadcastRoomState(room) {
  const publicState = serializeRoomPublic(room);

  if (room.phase !== PHASES.NIGHT) {
    io.to(room.key).emit('room_state', { room: publicState });
    return;
  }

  const maskedState = {
    ...publicState,
    players: publicState.players.map((p) => ({ ...p, isMuted: true })),
  };

  for (const player of room.players.values()) {
    const payload = isMafiaTeamRole(player.role) ? publicState : maskedState;
    io.to(player.id).emit('room_state', { room: payload });
  }
}

function systemMessage(room, text) {
  io.to(room.key).emit('system_message', { text, ts: Date.now() });
}

// ----------------------------------------------------------------------------
// اعتبارسنجی ورود / اتصال به اتاق
// ----------------------------------------------------------------------------

function validateJoinInput(rawUsername, rawRoomName) {
  const username = sanitizeText(rawUsername, VALIDATION.MAX_USERNAME_LEN);
  const roomName = sanitizeText(rawRoomName, VALIDATION.MAX_ROOMNAME_LEN);

  if (!isNonEmpty(username) || username.length < VALIDATION.MIN_USERNAME_LEN) {
    return { ok: false, message: `نام بازیکن باید حداقل ${VALIDATION.MIN_USERNAME_LEN} کاراکتر باشد.` };
  }
  if (!isNonEmpty(roomName) || roomName.length < VALIDATION.MIN_ROOMNAME_LEN) {
    return { ok: false, message: `نام اتاق باید حداقل ${VALIDATION.MIN_ROOMNAME_LEN} کاراکتر باشد.` };
  }
  return { ok: true, username, roomName };
}

function isUsernameTakenInRoom(room, username) {
  const lower = username.toLowerCase();
  return Array.from(room.players.values()).some(
    (p) => p.connected && p.username.toLowerCase() === lower
  );
}

// ----------------------------------------------------------------------------
// منطق نقش‌ها و شروع بازی
// ----------------------------------------------------------------------------

function buildDefaultRolesConfig(playerCount) {
  if (playerCount < VALIDATION.MIN_PLAYERS_TO_START) {
    return { mafia_boss: 0, mafia: 1, doctor_lecter: 0, doctor: 0, detective: 0, saqi: 0, natasha: 0, sniper: 0, citizen: Math.max(0, playerCount - 1) };
  }

  const mafiaTeamTotal = Math.max(1, Math.floor(playerCount / 4));
  const mafia_boss = 1;
  let mafiaSlotsLeft = mafiaTeamTotal - mafia_boss;
  const doctor_lecter = playerCount >= 6 && mafiaSlotsLeft >= 1 ? 1 : 0;
  mafiaSlotsLeft -= doctor_lecter;
  const mafia = Math.max(0, mafiaSlotsLeft);

  // آستانه‌ها عمداً پایین نگه داشته شده تا حتی با تعداد بازیکن کم هم بتوان
  // از تنوع نقش‌ها استفاده کرد؛ هاست همچنان می‌تواند هر نقش را دستی هم تنظیم کند.
  // این تخصیص slot-به-slot تضمین می‌کند مجموع همیشه دقیقاً برابر تعداد بازیکنان بماند.
  const config = { mafia_boss, mafia, doctor_lecter, doctor: 0, detective: 0, saqi: 0, natasha: 0, sniper: 0, citizen: 0 };
  let remaining = playerCount - (mafia_boss + mafia + doctor_lecter);

  const specialOrder = [
    { key: 'doctor', minPlayers: 4 },
    { key: 'detective', minPlayers: 4 },
    { key: 'saqi', minPlayers: 5 },
    { key: 'sniper', minPlayers: 5 },
    { key: 'natasha', minPlayers: 6 },
  ];
  for (const { key, minPlayers } of specialOrder) {
    if (remaining <= 0) break;
    if (playerCount >= minPlayers) {
      config[key] = 1;
      remaining -= 1;
    }
  }
  config.citizen = Math.max(0, remaining);

  return config;
}

function validateRolesConfig(rolesConfig, playerCount) {
  const keys = Object.keys(ROLE_DEFINITIONS);
  let total = 0;
  for (const k of Object.keys(rolesConfig)) {
    if (!keys.includes(k)) {
      return { ok: false, message: `نقش نامعتبر: ${k}` };
    }
    const val = rolesConfig[k];
    if (!Number.isInteger(val) || val < 0) {
      return { ok: false, message: `تعداد نقش «${k}» نامعتبر است.` };
    }
    total += val;
  }
  if (total !== playerCount) {
    return {
      ok: false,
      message: `مجموع نقش‌ها (${total}) باید دقیقاً برابر تعداد بازیکنان (${playerCount}) باشد.`,
    };
  }

  const mafiaTeamCount = (rolesConfig.mafia_boss || 0) + (rolesConfig.mafia || 0) + (rolesConfig.doctor_lecter || 0);
  if (mafiaTeamCount < 1) {
    return { ok: false, message: 'حداقل باید یک نفر عضو تیم مافیا باشد.' };
  }
  if (mafiaTeamCount * 2 >= playerCount) {
    return { ok: false, message: 'تعداد اعضای تیم مافیا نسبت به کل بازیکنان بیش از حد زیاد است.' };
  }
  if ((rolesConfig.mafia_boss || 0) > 1) {
    return { ok: false, message: 'حداکثر یک نفر می‌تواند رئیس مافیا باشد.' };
  }
  return { ok: true };
}

function assignRolesToPlayers(room) {
  const roleList = [];
  for (const [roleKeyName, count] of Object.entries(room.rolesConfig)) {
    for (let i = 0; i < count; i++) roleList.push(roleKeyName);
  }
  const shuffledRoles = shuffle(roleList);
  const players = shuffle(Array.from(room.players.values()));

  players.forEach((player, idx) => {
    player.role = shuffledRoles[idx];
    player.isAlive = true;
    const def = ROLE_DEFINITIONS[player.role];
    player.sniperBulletsRemaining = player.role === 'sniper' ? def.maxUses : null;

    io.to(player.id).emit('your_role', {
      role: def.key,
      team: def.team,
      description: def.description,
      displayName: def.displayName,
      bulletsRemaining: player.sniperBulletsRemaining,
    });
  });
}

/** برای تیم مافیا (رئیس/ساده/لکتر) روستر هم‌تیمی‌های زنده را خصوصی می‌فرستد؛ ابتدای هر شب صدا زده می‌شود. */
function sendMafiaTeammatesRoster(room) {
  const mafiaTeam = alivePlayers(room).filter((p) => ROLE_DEFINITIONS[p.role]?.team === TEAMS.MAFIA);
  mafiaTeam.forEach((player) => {
    const teammates = mafiaTeam
      .filter((p) => p.id !== player.id)
      .map((p) => ({ id: p.id, username: p.username, role: p.role }));
    io.to(player.id).emit('mafia_teammates', { teammates });
  });
}

// ----------------------------------------------------------------------------
// State machine فازهای بازی
// ----------------------------------------------------------------------------

function setPhase(room, phase) {
  room.phase = phase;
  io.to(room.key).emit('phase_changed', { phase: room.phase, dayNumber: room.dayNumber });
}

function startGame(room, requesterId) {
  const player = getPlayer(room, requesterId);
  if (!player || !player.isHost) {
    io.to(requesterId).emit('start_game_error', { message: 'فقط سازنده‌ی اتاق می‌تواند بازی را شروع کند.' });
    return;
  }
  if (room.phase !== PHASES.LOBBY) {
    io.to(requesterId).emit('start_game_error', { message: 'بازی از قبل در حال اجراست.' });
    return;
  }

  const activePlayers = connectedPlayers(room);
  if (activePlayers.length < VALIDATION.MIN_PLAYERS_TO_START) {
    io.to(requesterId).emit('start_game_error', {
      message: `حداقل ${VALIDATION.MIN_PLAYERS_TO_START} بازیکن برای شروع لازم است.`,
    });
    return;
  }

  const notReady = activePlayers.filter((p) => !p.isReady && !p.isHost);
  if (notReady.length > 0) {
    io.to(requesterId).emit('start_game_error', {
      message: `همه‌ی بازیکنان باید آماده باشند. (${notReady.map((p) => p.username).join('، ')} آماده نیستند)`,
    });
    return;
  }

  const rolesConfig = room.rolesConfig || buildDefaultRolesConfig(activePlayers.length);
  const validation = validateRolesConfig(rolesConfig, activePlayers.length);
  if (!validation.ok) {
    io.to(requesterId).emit('start_game_error', { message: validation.message });
    return;
  }
  room.rolesConfig = rolesConfig;

  assignRolesToPlayers(room);
  room.dayNumber = 1;
  room.votes = new Map();
  room.votingRound = 1;
  room.defendantId = null;
  room.silencedPlayerId = null;
  room.nightActions = freshNightActions();
  room.winner = null;

  setPhase(room, PHASES.ROLE_REVEAL);
  systemMessage(room, 'بازی شروع شد. نقش خود را در پنل خصوصی مشاهده کنید.');
  broadcastRoomState(room);

  setTimeout(() => {
    if (room.phase === PHASES.ROLE_REVEAL) {
      enterNightPhase(room);
    }
  }, 8000);
}

function enterNightPhase(room) {
  room.nightActions = freshNightActions();
  room.silencedPlayerId = null;
  setPhase(room, PHASES.NIGHT);
  systemMessage(room, `شب ${room.dayNumber} فرا رسید. نقش‌های شبانه اکشن خود را انجام دهند.`);
  sendMafiaTeammatesRoster(room);
  broadcastRoomState(room);
}

function allNightActionsSubmitted(room) {
  const alive = alivePlayers(room);
  const na = room.nightActions;

  const boss = alive.find((p) => p.role === 'mafia_boss');
  const regularMafia = alive.filter((p) => p.role === 'mafia');
  const doctor = alive.find((p) => p.role === 'doctor');
  const detective = alive.find((p) => p.role === 'detective');
  const saqi = alive.find((p) => p.role === 'saqi');
  const natasha = alive.find((p) => p.role === 'natasha');
  const lecter = alive.find((p) => p.role === 'doctor_lecter');
  const snipers = alive.filter((p) => p.role === 'sniper' && (p.sniperBulletsRemaining || 0) > 0);

  const mafiaTeamDone = boss
    ? na.bossActedBy === boss.id
    : regularMafia.length === 0 || regularMafia.every((m) => na.mafiaTargets.has(m.id));

  const doctorDone = !doctor || na.doctorActedBy === doctor.id;
  const detectiveDone = !detective || na.detectiveActedBy === detective.id;
  const saqiDone = !saqi || na.saqiActedBy === saqi.id;
  const natashaDone = !natasha || na.natashaActedBy === natasha.id;
  const lecterDone = !lecter || na.lecterActedBy === lecter.id;
  const sniperDone = snipers.every((s) => na.sniperActedIds.has(s.id));

  return mafiaTeamDone && doctorDone && detectiveDone && saqiDone && natashaDone && lecterDone && sniperDone;
}

function handleNightAction(room, socketId, targetId) {
  const player = getPlayer(room, socketId);
  if (!player || !player.isAlive) {
    io.to(socketId).emit('night_action_error', { message: 'شما نمی‌توانید در حال حاضر اکشنی انجام دهید.' });
    return;
  }
  if (room.phase !== PHASES.NIGHT) {
    io.to(socketId).emit('night_action_error', { message: 'در حال حاضر فاز شب نیست.' });
    return;
  }
  const target = targetId ? getPlayer(room, targetId) : null;
  if (targetId && (!target || !target.isAlive)) {
    io.to(socketId).emit('night_action_error', { message: 'هدف انتخابی معتبر نیست.' });
    return;
  }

  const na = room.nightActions;
  const ack = (message) => io.to(socketId).emit('night_action_ack', { message });
  const err = (message) => io.to(socketId).emit('night_action_error', { message });
  const bossAlive = alivePlayers(room).find((p) => p.role === 'mafia_boss');

  switch (player.role) {
    case 'mafia_boss':
      na.bossTarget = targetId || null;
      na.bossActedBy = player.id;
      ack('هدف نهایی شما به‌عنوان رئیس مافیا ثبت شد.');
      break;

    case 'mafia':
      if (bossAlive) {
        err('رئیس مافیا زنده است؛ تصمیم نهایی با اوست.');
        return;
      }
      na.mafiaTargets.set(player.id, targetId || null);
      ack('پیشنهاد شما برای هدف امشب ثبت شد.');
      break;

    case 'doctor':
      na.doctorSave = targetId || null;
      na.doctorActedBy = player.id;
      ack('نجات شما ثبت شد.');
      break;

    case 'detective': {
      na.detectiveCheck = targetId || null;
      na.detectiveActedBy = player.id;
      ack('استعلام شما ثبت شد.');
      if (target) {
        const def = ROLE_DEFINITIONS[target.role];
        io.to(socketId).emit('detective_result', {
          targetId: target.id,
          targetUsername: target.username,
          team: def.team,
        });
      }
      break;
    }

    case 'saqi':
      na.saqiTarget = targetId || null;
      na.saqiActedBy = player.id;
      ack('انتخاب شما برای مست‌کردن ثبت شد.');
      break;

    case 'natasha':
      na.natashaTarget = targetId || null;
      na.natashaActedBy = player.id;
      ack('انتخاب شما برای سایلنت‌کردن ثبت شد.');
      break;

    case 'doctor_lecter': {
      if (target && ROLE_DEFINITIONS[target.role]?.team !== TEAMS.MAFIA) {
        err('فقط می‌توانید یکی از هم‌تیمی‌های مافیا را محافظت کنید.');
        return;
      }
      na.lecterProtect = targetId || null;
      na.lecterActedBy = player.id;
      ack('محافظت شما ثبت شد.');
      break;
    }

    case 'sniper': {
      if ((player.sniperBulletsRemaining || 0) <= 0) {
        err('تیری برای شما باقی نمانده است.');
        return;
      }
      if (targetId) na.sniperShots.set(player.id, targetId);
      na.sniperActedIds.add(player.id);
      ack(targetId ? 'شلیک شما ثبت شد.' : 'تصمیم گرفتید امشب شلیک نکنید.');
      break;
    }

    default:
      err('نقش شما اکشن شبانه ندارد.');
      return;
  }

  if (allNightActionsSubmitted(room)) {
    resolveNightActions(room);
  }
}

function forceResolveNight(room, requesterId) {
  const player = getPlayer(room, requesterId);
  if (!player || !player.isHost) {
    io.to(requesterId).emit('night_action_error', { message: 'فقط هاست می‌تواند شب را زودتر تمام کند.' });
    return;
  }
  if (room.phase !== PHASES.NIGHT) return;
  resolveNightActions(room);
}

/** تمام اکشن‌های ثبت‌شده‌ی شب را طبق ترتیب منطقی (ساقی -> مافیا/لکتر -> تک‌تیرانداز -> ناتاشا) اجرا می‌کند. */
function resolveNightActions(room) {
  const na = room.nightActions;
  const aliveSnapshot = alivePlayers(room);

  const drugged = na.saqiTarget || null;
  const isDrugged = (id) => !!drugged && id === drugged;

  const bossPlayer = aliveSnapshot.find((p) => p.role === 'mafia_boss');
  const doctorPlayer = aliveSnapshot.find((p) => p.role === 'doctor');
  const lecterPlayer = aliveSnapshot.find((p) => p.role === 'doctor_lecter');
  const natashaPlayer = aliveSnapshot.find((p) => p.role === 'natasha');

  // --- هدف نهایی مافیا ---
  let mafiaKillTarget = null;
  if (bossPlayer) {
    if (!isDrugged(bossPlayer.id)) mafiaKillTarget = na.bossTarget || null;
  } else {
    const tally = new Map();
    for (const [mafiaId, targetId] of na.mafiaTargets.entries()) {
      if (isDrugged(mafiaId) || !targetId) continue;
      tally.set(targetId, (tally.get(targetId) || 0) + 1);
    }
    mafiaKillTarget = pickMaxFromTally(tally);
  }

  const savedId = doctorPlayer && !isDrugged(doctorPlayer.id) ? na.doctorSave : null;
  const protectedMafiaId = lecterPlayer && !isDrugged(lecterPlayer.id) ? na.lecterProtect : null;

  const deaths = [];

  if (mafiaKillTarget && mafiaKillTarget !== savedId) {
    const victim = getPlayer(room, mafiaKillTarget);
    if (victim && victim.isAlive) {
      victim.isAlive = false;
      deaths.push({ id: victim.id, username: victim.username, cause: 'mafia' });
    }
  }

  // --- شلیک‌های تک‌تیرانداز ---
  for (const [shooterId, targetId] of na.sniperShots.entries()) {
    if (isDrugged(shooterId) || !targetId) continue;
    const shooter = getPlayer(room, shooterId);
    if (!shooter || !shooter.isAlive) continue;
    const target = getPlayer(room, targetId);
    if (!target || !target.isAlive) continue;

    shooter.sniperBulletsRemaining = Math.max(0, (shooter.sniperBulletsRemaining || 0) - 1);
    const targetTeam = ROLE_DEFINITIONS[target.role]?.team;

    if (targetTeam === TEAMS.MAFIA) {
      if (target.id !== protectedMafiaId && target.isAlive) {
        target.isAlive = false;
        deaths.push({ id: target.id, username: target.username, cause: 'sniper' });
      }
    } else if (shooter.isAlive) {
      shooter.isAlive = false;
      deaths.push({ id: shooter.id, username: shooter.username, cause: 'sniper_miss' });
    }
  }

  // --- سایلنت ناتاشا برای روز بعد ---
  room.silencedPlayerId = null;
  if (natashaPlayer && !isDrugged(natashaPlayer.id) && natashaPlayer.isAlive && na.natashaTarget) {
    const silenceTarget = getPlayer(room, na.natashaTarget);
    if (silenceTarget && silenceTarget.isAlive) {
      room.silencedPlayerId = silenceTarget.id;
    }
  }

  if (drugged) {
    const druggedPlayer = getPlayer(room, drugged);
    if (druggedPlayer) {
      io.to(drugged).emit('saqi_effect', { message: 'دیشب توسط ساقی مست شدید و اکشن شما اجرا نشد.' });
    }
  }

  io.to(room.key).emit('night_result', { deaths, noDeath: deaths.length === 0 });
  deaths.forEach((d) => systemMessage(room, `${d.username} در طول شب حذف شد.`));
  if (deaths.length === 0) systemMessage(room, 'دیشب کسی حذف نشد.');

  if (room.silencedPlayerId) {
    const silenced = getPlayer(room, room.silencedPlayerId);
    if (silenced) {
      silenced.isMuted = true;
      io.to(room.key).emit('voice_mute_state', { peerId: silenced.id, isMuted: true });
      systemMessage(room, `${silenced.username} امروز توسط ناتاشا سایلنت شده و نمی‌تواند صحبت کند.`);
    }
  }

  broadcastRoomState(room);

  const winCheck = checkWinCondition(room);
  if (winCheck.over) {
    endGame(room, winCheck.winner, winCheck.reason);
    return;
  }

  setPhase(room, PHASES.DAY);
  systemMessage(room, `روز ${room.dayNumber} آغاز شد. بحث و گفت‌وگو کنید.`);
  broadcastRoomState(room);
}

function advanceToVoting(room, requesterId) {
  const player = getPlayer(room, requesterId);
  if (!player || !player.isHost) {
    io.to(requesterId).emit('vote_error', { message: 'فقط هاست می‌تواند رأی‌گیری را شروع کند.' });
    return;
  }
  if (room.phase !== PHASES.DAY) return;

  room.votes = new Map();
  room.votingRound = 1;
  room.defendantId = null;
  setPhase(room, PHASES.VOTING);
  systemMessage(room, 'رأی‌گیری آغاز شد. لطفاً به فردی که فکر می‌کنید مافیاست رأی دهید.');
  broadcastRoomState(room);
}

function handleDayVote(room, socketId, targetId) {
  const voter = getPlayer(room, socketId);
  if (!voter || !voter.isAlive) {
    io.to(socketId).emit('vote_error', { message: 'بازیکنان حذف‌شده نمی‌توانند رأی دهند.' });
    return;
  }
  if (room.phase !== PHASES.VOTING) {
    io.to(socketId).emit('vote_error', { message: 'در حال حاضر فاز رأی‌گیری نیست.' });
    return;
  }
  if (targetId) {
    const target = getPlayer(room, targetId);
    if (!target || !target.isAlive) {
      io.to(socketId).emit('vote_error', { message: 'هدف رأی نامعتبر است.' });
      return;
    }
  }

  room.votes.set(voter.id, targetId || null);

  const tally = {};
  for (const t of room.votes.values()) {
    if (!t) continue;
    tally[t] = (tally[t] || 0) + 1;
  }
  io.to(room.key).emit('vote_update', { votes: Object.fromEntries(room.votes), tally });

  const alive = alivePlayers(room);
  if (room.votes.size >= alive.length) {
    resolveVotingRound(room);
  }
}

/**
 * یک دور رأی‌گیری را می‌بندد. اگر یک نفر به‌تنهایی به آستانه‌ی «نصف یا بیشتر
 * آرای زنده‌ها» برسد: در دور اول -> وارد فاز دفاعیه می‌شود؛ در دور دوم (بعد
 * از دفاعیه) -> مستقیم حذف می‌شود. در غیر این صورت (تساوی یا زیر آستانه)،
 * بدون حذف به شب بعد می‌رویم.
 */
function resolveVotingRound(room) {
  const tally = new Map();
  for (const targetId of room.votes.values()) {
    if (!targetId) continue;
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  }

  let max = -1;
  let candidates = [];
  for (const [targetId, count] of tally.entries()) {
    if (count > max) {
      max = count;
      candidates = [targetId];
    } else if (count === max) {
      candidates.push(targetId);
    }
  }

  const aliveCount = alivePlayers(room).length;
  const threshold = Math.ceil(aliveCount / 2);
  const reachedThreshold = candidates.length === 1 && max >= threshold;

  if (reachedThreshold && room.votingRound === 1) {
    io.to(room.key).emit('voting_result', { eliminated: null, tie: false, wentToDefense: true });
    startDefensePhase(room, candidates[0]);
    return;
  }

  let eliminated = null;
  if (reachedThreshold && room.votingRound === 2) {
    const target = getPlayer(room, candidates[0]);
    if (target && target.isAlive) {
      target.isAlive = false;
      eliminated = { id: target.id, username: target.username };
    }
  }

  const isTie = candidates.length > 1;
  io.to(room.key).emit('voting_result', { eliminated, tie: isTie, wentToDefense: false });
  if (eliminated) {
    systemMessage(room, `${eliminated.username} با رأی جمعی از بازی حذف شد.`);
  } else {
    systemMessage(room, 'رأی‌گیری به نتیجه‌ی قطعی نرسید و کسی حذف نشد.');
  }

  broadcastRoomState(room);

  const winCheck = checkWinCondition(room);
  if (winCheck.over) {
    endGame(room, winCheck.winner, winCheck.reason);
    return;
  }

  room.dayNumber += 1;
  enterNightPhase(room);
}

function endVotingEarly(room, requesterId) {
  const player = getPlayer(room, requesterId);
  if (!player || !player.isHost) {
    io.to(requesterId).emit('vote_error', { message: 'فقط هاست می‌تواند رأی‌گیری را زودتر تمام کند.' });
    return;
  }
  if (room.phase !== PHASES.VOTING) return;
  resolveVotingRound(room);
}

// ----------------------------------------------------------------------------
// فاز دفاعیه
// ----------------------------------------------------------------------------

/** فردی که به آستانه‌ی رأی رسیده وارد فاز دفاعیه می‌شود: ۷۵ ثانیه فقط او صحبت می‌کند. */
function startDefensePhase(room, defendantId) {
  const defendant = getPlayer(room, defendantId);
  if (!defendant) return;

  room.defendantId = defendantId;

  for (const p of room.players.values()) {
    if (p.id !== defendantId) p.isMuted = true;
  }

  setPhase(room, PHASES.DEFENSE);
  io.to(room.key).emit('defense_started', {
    defendantId,
    defendantUsername: defendant.username,
    durationMs: DEFENSE_DURATION_MS,
  });
  systemMessage(room, `${defendant.username} با نصف یا بیشتر آرا مواجه شد و ۷۵ ثانیه فرصت دفاع دارد.`);
  broadcastRoomState(room);

  if (room._defenseTimer) clearTimeout(room._defenseTimer);
  room._defenseTimer = setTimeout(() => {
    if (room.phase === PHASES.DEFENSE) endDefensePhase(room);
  }, DEFENSE_DURATION_MS);
}

function endDefensePhase(room) {
  if (room._defenseTimer) {
    clearTimeout(room._defenseTimer);
    room._defenseTimer = null;
  }

  for (const p of room.players.values()) {
    p.isMuted = false;
  }

  room.votingRound = 2;
  room.defendantId = null;
  room.votes = new Map();

  io.to(room.key).emit('defense_ended', {});
  setPhase(room, PHASES.VOTING);
  systemMessage(room, 'زمان دفاعیه تمام شد. رأی‌گیری نهایی آغاز می‌شود.');
  broadcastRoomState(room);
}

function endDefenseEarly(room, requesterId) {
  const player = getPlayer(room, requesterId);
  if (!player || !player.isHost) {
    io.to(requesterId).emit('vote_error', { message: 'فقط هاست می‌تواند دفاعیه را زودتر تمام کند.' });
    return;
  }
  if (room.phase !== PHASES.DEFENSE) return;
  endDefensePhase(room);
}

// ----------------------------------------------------------------------------
// شرط برد
// ----------------------------------------------------------------------------

function checkWinCondition(room) {
  const alive = alivePlayers(room);
  const mafiaAlive = alive.filter((p) => ROLE_DEFINITIONS[p.role]?.team === TEAMS.MAFIA).length;
  const citizenAlive = alive.filter((p) => ROLE_DEFINITIONS[p.role]?.team === TEAMS.CITIZEN).length;

  if (mafiaAlive === 0) {
    return { over: true, winner: TEAMS.CITIZEN, reason: 'تمام اعضای مافیا حذف شدند.' };
  }
  if (mafiaAlive > citizenAlive) {
    return { over: true, winner: TEAMS.MAFIA, reason: 'تعداد مافیا بیشتر از شهروندان شد.' };
  }
  if (mafiaAlive === citizenAlive && mafiaAlive === 1) {
    return { over: true, winner: TEAMS.MAFIA, reason: 'فقط یک مافیا در برابر یک شهروند باقی مانده و مافیا برنده شد.' };
  }
  // تساوی‌های بالاتر (۲ به ۲، ۳ به ۳ و ...) ادامه‌ی بازی محسوب می‌شود، نه برد مافیا.
  return { over: false };
}

function endGame(room, winner, reason) {
  room.winner = winner;
  if (room._defenseTimer) {
    clearTimeout(room._defenseTimer);
    room._defenseTimer = null;
  }
  setPhase(room, PHASES.ENDED);

  const rolesReveal = {};
  for (const p of room.players.values()) {
    rolesReveal[p.id] = p.role;
  }

  io.to(room.key).emit('game_over', { winner, reason, roles: rolesReveal });
  systemMessage(
    room,
    winner === TEAMS.MAFIA ? `تیم مافیا برنده شد! (${reason})` : `تیم شهروندان برنده شد! (${reason})`
  );
  broadcastRoomState(room);
}

function resetRoomToLobby(room, requesterId) {
  const player = getPlayer(room, requesterId);
  if (!player || !player.isHost) return;

  if (room._defenseTimer) {
    clearTimeout(room._defenseTimer);
    room._defenseTimer = null;
  }

  for (const p of room.players.values()) {
    p.isReady = p.isHost;
    p.isAlive = true;
    p.role = null;
    p.isMuted = false;
    p.sniperBulletsRemaining = null;
  }
  room.phase = PHASES.LOBBY;
  room.dayNumber = 0;
  room.winner = null;
  room.votes = new Map();
  room.votingRound = 1;
  room.defendantId = null;
  room.silencedPlayerId = null;
  room.nightActions = freshNightActions();

  io.to(room.key).emit('reset_to_lobby', { room: serializeRoomPublic(room) });
  systemMessage(room, 'اتاق برای دور جدید بازنشانی شد.');
  broadcastRoomState(room);
}

// ----------------------------------------------------------------------------
// مدیریت host و خروج/قطعی بازیکن
// ----------------------------------------------------------------------------

function reassignHostIfNeeded(room) {
  if (room.hostId && room.players.has(room.hostId) && room.players.get(room.hostId).connected) {
    return;
  }
  const nextHost = connectedPlayers(room)[0];
  if (nextHost) {
    if (room.hostId && room.players.has(room.hostId)) {
      room.players.get(room.hostId).isHost = false;
    }
    nextHost.isHost = true;
    nextHost.isReady = true;
    room.hostId = nextHost.id;
    systemMessage(room, `${nextHost.username} هاست جدید اتاق شد.`);
  } else {
    room.hostId = null;
  }
}

function removeRoomIfEmpty(room) {
  const anyone = Array.from(room.players.values()).some((p) => p.connected);
  if (!anyone) {
    if (room._defenseTimer) clearTimeout(room._defenseTimer);
    rooms.delete(room.key);
  }
}

function handleLeaveRoom(socket, { silent } = {}) {
  const roomKeyForSocket = socketRoomIndex.get(socket.id);
  if (!roomKeyForSocket) return;

  const room = getRoom(roomKeyForSocket);
  socketRoomIndex.delete(socket.id);
  socket.leave(roomKeyForSocket);

  if (!room) return;

  const player = room.players.get(socket.id);
  if (!player) return;

  if (room.phase === PHASES.LOBBY) {
    room.players.delete(socket.id);
  } else {
    player.connected = false;
    player.inVoice = false;
  }

  socket.to(room.key).emit('voice_peer_left', { peerId: socket.id });

  reassignHostIfNeeded(room);

  if (!silent) {
    systemMessage(room, `${player.username} از اتاق خارج شد.`);
  }

  removeRoomIfEmpty(room);
  if (rooms.has(room.key)) {
    broadcastRoomState(room);
  }
}

// ----------------------------------------------------------------------------
// Socket.IO: اتصال و رویدادها
// ----------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('join_room', (payload) => {
    const { username: rawUsername, roomName: rawRoomName } = payload || {};
    const validation = validateJoinInput(rawUsername, rawRoomName);
    if (!validation.ok) {
      socket.emit('join_error', { message: validation.message });
      return;
    }
    const { username, roomName } = validation;
    const key = roomKey(roomName);

    let room = getRoom(key);
    const isNewRoom = !room;
    if (!room) {
      room = createRoom(roomName);
      rooms.set(key, room);
    }

    if (room.players.size >= VALIDATION.MAX_PLAYERS_PER_ROOM) {
      socket.emit('join_error', { message: 'ظرفیت این اتاق تکمیل است.' });
      return;
    }
    if (room.phase !== PHASES.LOBBY) {
      socket.emit('join_error', { message: 'بازی این اتاق از قبل شروع شده است.' });
      return;
    }
    if (isUsernameTakenInRoom(room, username)) {
      socket.emit('join_error', { message: 'این نام در همین اتاق قبلاً استفاده شده است.' });
      return;
    }

    const isHost = isNewRoom || connectedPlayers(room).length === 0;
    const player = createPlayer(socket.id, username, room.key, isHost);
    room.players.set(socket.id, player);
    if (isHost) room.hostId = socket.id;

    socket.join(room.key);
    socketRoomIndex.set(socket.id, room.key);

    socket.emit('joined_room', { room: serializeRoomPublic(room), you: player });
    systemMessage(room, `${username} به اتاق پیوست.`);
    broadcastRoomState(room);
  });

  socket.on('toggle_ready', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    const player = getPlayer(room, socket.id);
    if (!room || !player || room.phase !== PHASES.LOBBY || player.isHost) return;
    player.isReady = !player.isReady;
    broadcastRoomState(room);
  });

  socket.on('update_room_settings', (payload) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    const player = getPlayer(room, socket.id);
    if (!room || !player || !player.isHost || room.phase !== PHASES.LOBBY) return;

    const { rolesConfig } = payload || {};
    if (!rolesConfig || typeof rolesConfig !== 'object') return;

    const playerCount = connectedPlayers(room).length;
    const validation = validateRolesConfig(rolesConfig, playerCount);
    if (!validation.ok) {
      socket.emit('start_game_error', { message: validation.message });
      return;
    }
    room.rolesConfig = rolesConfig;
    broadcastRoomState(room);
  });

  socket.on('start_game', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    startGame(room, socket.id);
  });

  socket.on('acknowledge_role', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room || room.phase !== PHASES.ROLE_REVEAL) return;
    room._acknowledged = room._acknowledged || new Set();
    room._acknowledged.add(socket.id);
    const needed = connectedPlayers(room).length;
    if (room._acknowledged.size >= needed) {
      room._acknowledged = new Set();
      enterNightPhase(room);
    }
  });

  socket.on('night_action', (payload) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    handleNightAction(room, socket.id, payload && payload.targetId);
  });

  socket.on('force_resolve_night', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    forceResolveNight(room, socket.id);
  });

  socket.on('advance_to_voting', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    advanceToVoting(room, socket.id);
  });

  socket.on('day_vote', (payload) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    handleDayVote(room, socket.id, payload && payload.targetId);
  });

  socket.on('end_voting', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    endVotingEarly(room, socket.id);
  });

  socket.on('end_defense', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    endDefenseEarly(room, socket.id);
  });

  socket.on('play_again', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room) return;
    resetRoomToLobby(room, socket.id);
  });

  socket.on('leave_room', () => {
    handleLeaveRoom(socket);
  });

  // ---------------- ویس (WebRTC signaling) ----------------

  socket.on('voice_join', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    const player = getPlayer(room, socket.id);
    if (!room || !player) return;
    player.inVoice = true;
    socket.to(room.key).emit('voice_peer_joined', { peerId: socket.id });
    broadcastRoomState(room);
  });

  socket.on('voice_leave', () => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    const player = getPlayer(room, socket.id);
    if (!room || !player) return;
    player.inVoice = false;
    socket.to(room.key).emit('voice_peer_left', { peerId: socket.id });
    broadcastRoomState(room);
  });

  socket.on('voice_offer', ({ targetId, sdp } = {}) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room || !targetId || !room.players.has(targetId)) return;
    io.to(targetId).emit('voice_offer', { fromId: socket.id, sdp });
  });

  socket.on('voice_answer', ({ targetId, sdp } = {}) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room || !targetId || !room.players.has(targetId)) return;
    io.to(targetId).emit('voice_answer', { fromId: socket.id, sdp });
  });

  socket.on('voice_ice_candidate', ({ targetId, candidate } = {}) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    if (!room || !targetId || !room.players.has(targetId)) return;
    io.to(targetId).emit('voice_ice_candidate', { fromId: socket.id, candidate });
  });

  socket.on('voice_toggle_mute', ({ isMuted } = {}) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    const player = getPlayer(room, socket.id);
    if (!room || !player) return;
    // در فاز دفاعیه یا وقتی سایلنتِ ناتاشا هستید، کلاینت خودش دکمه را غیرفعال
    // می‌کند؛ این چک هم به‌عنوان یک لایه‌ی دفاعی سمت سرور اضافه شده.
    if (room.phase === PHASES.DEFENSE && room.defendantId !== player.id) return;
    if (room.silencedPlayerId === player.id && room.phase === PHASES.DAY) return;
    if (room.phase === PHASES.NIGHT && !isMafiaTeamRole(player.role)) return;
    player.isMuted = !!isMuted;

    if (room.phase === PHASES.NIGHT) {
      // فقط به تیم مافیا خبر داده می‌شود، وگرنه شهروندان از روی «کی باز شد»
      // می‌فهمند مافیا کیست. برای غیرمافیا، room_state ماسک‌شده (همه قطع)
      // به‌تنهایی کافی است و اینجا چیزی برایشان ارسال نمی‌شود.
      for (const viewer of room.players.values()) {
        if (isMafiaTeamRole(viewer.role)) {
          io.to(viewer.id).emit('voice_mute_state', { peerId: socket.id, isMuted: player.isMuted });
        }
      }
    } else {
      io.to(room.key).emit('voice_mute_state', { peerId: socket.id, isMuted: player.isMuted });
    }
  });

  socket.on('voice_speaking', ({ isSpeaking } = {}) => {
    const room = getRoom(socketRoomIndex.get(socket.id));
    const player = getPlayer(room, socket.id);
    if (!room || !player) return;

    if (room.phase === PHASES.NIGHT) {
      if (!isMafiaTeamRole(player.role)) return; // شهروند در شب سایلنت است؛ چیزی برای گزارش نیست
      for (const viewer of room.players.values()) {
        if (viewer.id === player.id) continue;
        if (isMafiaTeamRole(viewer.role)) {
          io.to(viewer.id).emit('voice_speaking_state', { peerId: socket.id, isSpeaking: !!isSpeaking });
        }
      }
    } else {
      socket.to(room.key).emit('voice_speaking_state', { peerId: socket.id, isSpeaking: !!isSpeaking });
    }
  });

  socket.on('disconnect', () => {
    handleLeaveRoom(socket, { silent: false });
  });
});

// ----------------------------------------------------------------------------
// فایل‌های استاتیک فرانت‌اند
// ----------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Mafia server running on http://localhost:${PORT}`);
});

module.exports = { app, server, io, rooms };
