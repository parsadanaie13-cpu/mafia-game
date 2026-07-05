'use strict';

/**
 * ============================================================================
 *  MAFIA ONLINE - client.js
 * ============================================================================
 *
 *  این فایل باید دقیقاً با دو قرارداد زیر هماهنگ باشد:
 *   1) قرارداد Eventهای Socket.IO که بالای server.js مستند شده است.
 *   2) نقشه‌ی idهای HTML که بالای index.html مستند شده است.
 *
 *  اگر در آینده نام eventی یا idای تغییر کند، باید همزمان اینجا هم اصلاح شود.
 *  برای جلوگیری از خطای تایپی، تمام نام‌های event در EVT و تمام idها در DOM
 *  cache یک‌جا تعریف شده‌اند؛ بقیه‌ی کد فقط از این دو منبع استفاده می‌کند.
 * ============================================================================
 */

(function () {
  // ==========================================================================
  // بخش ۱: ثابت‌ها - نام Eventها (باید کلمه‌به‌کلمه با server.js یکی باشد)
  // ==========================================================================

  const EVT = Object.freeze({
    // Client -> Server
    JOIN_ROOM: 'join_room',
    TOGGLE_READY: 'toggle_ready',
    UPDATE_ROOM_SETTINGS: 'update_room_settings',
    START_GAME: 'start_game',
    ACKNOWLEDGE_ROLE: 'acknowledge_role',
    NIGHT_ACTION: 'night_action',
    FORCE_RESOLVE_NIGHT: 'force_resolve_night',
    ADVANCE_TO_VOTING: 'advance_to_voting',
    DAY_VOTE: 'day_vote',
    END_VOTING: 'end_voting',
    END_DEFENSE: 'end_defense',
    PLAY_AGAIN: 'play_again',
    LEAVE_ROOM: 'leave_room',

    VOICE_JOIN: 'voice_join',
    VOICE_LEAVE: 'voice_leave',
    VOICE_OFFER: 'voice_offer',
    VOICE_ANSWER: 'voice_answer',
    VOICE_ICE_CANDIDATE: 'voice_ice_candidate',
    VOICE_TOGGLE_MUTE: 'voice_toggle_mute',
    VOICE_SPEAKING: 'voice_speaking',

    // Server -> Client
    JOIN_ERROR: 'join_error',
    JOINED_ROOM: 'joined_room',
    ROOM_STATE: 'room_state',
    SYSTEM_MESSAGE: 'system_message',
    START_GAME_ERROR: 'start_game_error',
    YOUR_ROLE: 'your_role',
    MAFIA_TEAMMATES: 'mafia_teammates',
    PHASE_CHANGED: 'phase_changed',
    NIGHT_ACTION_ACK: 'night_action_ack',
    NIGHT_ACTION_ERROR: 'night_action_error',
    DETECTIVE_RESULT: 'detective_result',
    SAQI_EFFECT: 'saqi_effect',
    NIGHT_RESULT: 'night_result',
    VOTE_UPDATE: 'vote_update',
    VOTE_ERROR: 'vote_error',
    DEFENSE_STARTED: 'defense_started',
    DEFENSE_ENDED: 'defense_ended',
    VOTING_RESULT: 'voting_result',
    GAME_OVER: 'game_over',
    RESET_TO_LOBBY: 'reset_to_lobby',

    VOICE_PEER_JOINED: 'voice_peer_joined',
    VOICE_PEER_LEFT: 'voice_peer_left',
    VOICE_MUTE_STATE: 'voice_mute_state',
    VOICE_SPEAKING_STATE: 'voice_speaking_state',
  });

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

  const ROLE_LABELS = Object.freeze({
    mafia_boss: 'رئیس مافیا',
    mafia: 'مافیای ساده',
    doctor_lecter: 'دکتر لکتر',
    doctor: 'دکتر',
    detective: 'کارآگاه',
    saqi: 'ساقی',
    natasha: 'ناتاشا',
    sniper: 'تک‌تیرانداز',
    citizen: 'شهروند',
  });

  const TEAM_LABELS = Object.freeze({
    mafia: 'تیم مافیا',
    citizen: 'تیم شهروندان',
  });

  const PHASE_LABELS = Object.freeze({
    lobby: 'لابی',
    role_reveal: 'نمایش نقش',
    night: 'شب',
    day: 'روز',
    voting: 'رأی‌گیری',
    defense: 'دفاعیه',
    results: 'نتیجه',
    ended: 'پایان بازی',
  });

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const SPEAKING_THRESHOLD = 0.06; // آستانه‌ی صدا برای تشخیص «در حال صحبت»
  const SPEAKING_HOLD_MS = 400; // بعد از سکوت، چند میلی‌ثانیه indicator نگه داشته شود
  const MAX_LOG_ITEMS = 60;

  /**
   * این مقادیر باید دقیقاً با VALIDATION در server.js یکی باشند. هدف از
   * تکرار آن‌ها اینجا صرفاً اعتبارسنجی زودهنگام (pre-flight) در کلاینت است
   * تا کاربر پیش از رفت‌وبرگشت به سرور از خطای احتمالی مطلع شود؛ اعتبارسنجی
   * نهایی و قطعی همیشه سمت سرور انجام می‌شود و کلاینت هرگز نباید جایگزین آن باشد.
   */
  const VALIDATION = Object.freeze({
    MIN_USERNAME_LEN: 2,
    MAX_USERNAME_LEN: 20,
    MIN_ROOMNAME_LEN: 2,
    MAX_ROOMNAME_LEN: 30,
    MIN_PLAYERS_TO_START: 4,
    MAX_PLAYERS_PER_ROOM: 20,
  });

  const LOCAL_STORAGE_KEYS = Object.freeze({
    USERNAME: 'mafia_online_last_username',
  });

  // ==========================================================================
  // بخش ۲: کش عناصر DOM - تمام idهای استفاده‌شده در index.html اینجا جمع شده
  // ==========================================================================

  const dom = {};

  /**
   * تمام idهای مورد نیاز را یک‌بار در ابتدای اجرا از DOM می‌خواند و در آبجکت
   * dom با نام camelCase ذخیره می‌کند (مثلاً «lobby-room-name» -> dom.lobbyRoomName).
   * اگر عنصری پیدا نشود، در کنسول خطای [DOM MISMATCH] چاپ می‌شود؛ این دقیقاً
   * همان مکانیزمی است که برای شکار زودهنگام ناهماهنگی بین index.html و
   * client.js طراحی شده - اگر این پیام دیده شود، یعنی یک id تغییر کرده و
   * باید در هر دو فایل هماهنگ شود.
   */
  function cacheDom() {
    const ids = [
      'connection-status',
      'connection-status-text',
      'toast-container',

      'view-login',
      'login-form',
      'input-username',
      'input-roomname',
      'btn-join',
      'login-error',

      'view-lobby',
      'lobby-room-name',
      'lobby-player-count',
      'btn-copy-room',
      'btn-leave-lobby',
      'lobby-player-list',
      'btn-toggle-ready',
      'lobby-ready-hint',
      'lobby-roles-config',
      'role-count-mafia-boss',
      'role-count-mafia',
      'role-count-doctor-lecter',
      'role-count-doctor',
      'role-count-detective',
      'role-count-saqi',
      'role-count-natasha',
      'role-count-sniper',
      'role-count-citizen',
      'btn-auto-roles',
      'btn-save-roles',
      'roles-config-total',
      'btn-start-game',
      'lobby-start-error',
      'lobby-system-log',

      'btn-voice-join',
      'btn-voice-leave',
      'btn-mic-toggle',
      'mic-device-select',
      'voice-status',
      'voice-permission-error',
      'audio-container',

      'view-game',
      'game-phase-banner',
      'game-phase-label',
      'game-phase-day',
      'game-player-list',
      'game-system-log',

      'btn-voice-join-ingame',
      'btn-voice-leave-ingame',
      'btn-mic-toggle-ingame',
      'voice-status-ingame',

      'panel-night',
      'night-mafia-panel',
      'night-mafia-role-flavor',
      'night-mafia-teammates',
      'night-mafia-targets',
      'night-doctor-panel',
      'night-doctor-targets',
      'night-detective-panel',
      'night-detective-targets',
      'detective-result-display',
      'night-saqi-panel',
      'night-saqi-targets',
      'night-natasha-panel',
      'night-natasha-targets',
      'night-sniper-panel',
      'sniper-bullets-remaining',
      'night-sniper-targets',
      'night-citizen-panel',
      'night-action-status',
      'btn-force-resolve-night',

      'panel-day',
      'day-message',
      'day-silenced-notice',
      'btn-advance-voting',

      'panel-voting',
      'voting-candidate-list',
      'voting-tally-display',
      'vote-error',
      'btn-end-voting',

      'panel-defense',
      'defense-message',
      'defense-countdown',
      'defense-mic-notice',
      'btn-end-defense',

      'panel-results',
      'results-message',

      'modal-role-reveal',
      'role-reveal-name',
      'role-reveal-team',
      'role-reveal-desc',
      'btn-ack-role',

      'modal-game-over',
      'game-over-winner',
      'game-over-reason',
      'game-over-roles-body',
      'btn-play-again',
      'btn-leave-after-game',

      'tpl-player-item',
      'tpl-target-button',
      'tpl-log-item',
    ];

    ids.forEach((id) => {
      const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const el = document.getElementById(id);
      if (!el) {
        // این هشدار دقیقاً برای شکار mismatch بین HTML و JS است.
        console.error(`[DOM MISMATCH] عنصری با id="${id}" در HTML پیدا نشد.`);
      }
      dom[camel] = el;
    });
  }

  // ==========================================================================
  // بخش ۳: وضعیت کلاینت (in-memory state)
  // ==========================================================================

  const clientState = {
    socket: null,
    room: null, // آخرین room_state دریافتی از سرور
    you: null, // اطلاعات خودم (از joined_room)
    myRole: null, // { role, team, description, displayName }

    // شب
    nightSelection: null, // targetId انتخاب‌شده در فاز شب (محلی، قبل از ack)
    nightActionSent: false,
    detectiveHistory: [], // { username, team, dayNumber } - تاریخچه‌ی استعلام‌های کارآگاه در این دور
    mafiaTeammates: [], // { id, username, role } - فقط برای تیم مافیا، از رویداد mafia_teammates

    // دفاعیه
    defendantId: null,
    defenseCountdownInterval: null,
    defenseEndsAt: null,
    forcedMuted: false, // آیا میکروفون به‌زور (دفاعیه/ناتاشا) قفل شده

    // رأی‌گیری
    myVoteTargetId: undefined, // undefined = هنوز رأی نداده؛ null = رأی سفید

    // Overlay نتیجه (بین شب/رأی‌گیری و فاز بعدی)
    resultsOverlayActive: false,
    resultsOverlayTimer: null,
    queuedPhasePayload: null,

    // ویس
    localStream: null,
    inVoice: false,
    isMuted: false,
    peers: new Map(), // peerId -> RTCPeerConnection
    senders: new Map(), // peerId -> RTCRtpSender (برای کنترل routing شبانه‌ی مافیا)
    audioEls: new Map(), // peerId -> <audio>
    speakingState: new Map(), // peerId -> bool
    audioContext: null,
    analyser: null,
    speakingLoopHandle: null,
    lastSpeakingSentAt: 0,
    lastSpeakingValue: false,
    speakingHoldTimer: null,
  };

  // ==========================================================================
  // بخش ۴: توابع کمکی عمومی (Utilities)
  // ==========================================================================

  /** میان‌بر کوتاه برای خواندن عنصر کش‌شده با id مشخص. */
  function el(id) {
    return dom[id];
  }

  /** کلاس hidden را از عنصر حذف می‌کند (یعنی نمایشش می‌دهد). */
  function show(elem) {
    if (elem) elem.classList.remove('hidden');
  }

  /** کلاس hidden را به عنصر اضافه می‌کند (یعنی مخفی‌اش می‌کند). */
  function hide(elem) {
    if (elem) elem.classList.add('hidden');
  }

  /** textContent عنصر را با null-check ایمن تنظیم می‌کند. */
  function setText(elem, text) {
    if (elem) elem.textContent = text == null ? '' : String(text);
  }

  /** تمام فرزندان یک عنصر را حذف می‌کند؛ سریع‌تر و امن‌تر از innerHTML = ''. */
  function clearChildren(elem) {
    if (!elem) return;
    while (elem.firstChild) elem.removeChild(elem.firstChild);
  }

  /** رشته‌ی ورودی را برای درج امن در HTML escape می‌کند (در این پروژه بیشتر برای دفاع در عمق است، چون از textContent استفاده می‌شود نه innerHTML). */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  /** timestamp را به‌صورت ساعت:دقیقه‌ی محلی (مثلاً «۱۴:۰۵») فرمت می‌کند؛ برای لاگ رویدادها. */
  function formatClock(ts) {
    const d = new Date(ts || Date.now());
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /**
   * یک پیام Toast کوتاه (۴ ثانیه‌ای) در پایین صفحه نشان می‌دهد. برای خطاهای
   * مهم (join_error، start_game_error، vote_error و ...) در کنار نمایش
   * پیام inline استفاده می‌شود تا کاربر حتماً متوجه شود، حتی اگر آن بخش از
   * صفحه در دید فعلی‌اش نباشد.
   * @param {string} message
   * @param {'info'|'success'|'error'} [kind]
   */
  function toast(message, kind) {
    if (!dom.toastContainer) return;
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.kind = kind || 'info';
    node.textContent = message;
    dom.toastContainer.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 250);
    }, 4000);
  }

  /**
   * Handlerهای سراسری خطا. هدف این نیست که خطا را «قورت بدهد»، بلکه اطمینان
   * می‌دهد یک خطای پیش‌بینی‌نشده در بخشی از UI کل بازی را از کار نمی‌اندازد؛
   * خطا در کنسول لاگ می‌شود و کاربر یک toast غیرفنی می‌بیند.
   */
  function wireGlobalErrorHandlers() {
    window.addEventListener('error', (event) => {
      console.error('[Unhandled Error]', event.error || event.message);
      toast('یک خطای غیرمنتظره رخ داد. اگر ادامه داشت، صفحه را رفرش کنید.', 'error');
    });
    window.addEventListener('unhandledrejection', (event) => {
      console.error('[Unhandled Promise Rejection]', event.reason);
    });
  }

  /**
   * وضعیت اتصال Socket.IO را مدیریت می‌کند و بین «اولین اتصال» و «اتصال
   * مجدد پس از قطعی» تمایز قائل می‌شود. چون این پروژه معماری session/token
   * برای بازیابی خودکار عضویت در اتاق ندارد (هر reconnect یعنی socket.id
   * جدید)، اگر کاربر از قبل داخل یک اتاق بوده و اتصال قطع/وصل شود، صادقانه
   * از او می‌خواهیم دوباره وارد شود؛ به‌جای نمایش وضعیتی گمراه‌کننده.
   */
  let hasConnectedBefore = false;

  function handleSocketConnect() {
    setConnectionState('connected', 'متصل به سرور');
    if (hasConnectedBefore && clientState.room) {
      toast('اتصال دوباره برقرار شد. لطفاً دوباره وارد اتاق شوید.', 'info');
      clientState.room = null;
      clientState.you = null;
      clientState.myRole = null;
      leaveVoice();
      showView('login');
    }
    hasConnectedBefore = true;
  }

  function handleSocketDisconnect() {
    setConnectionState('disconnected', 'اتصال قطع شد؛ در حال تلاش مجدد...');
  }
  function throttle(fn, waitMs) {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last >= waitMs) {
        last = now;
        fn(...args);
      }
    };
  }

  /**
   * نسخه‌ی استاندارد debounce: اجرای fn را تا زمانی که فراخوانی‌های جدید
   * متوقف نشوند به تعویق می‌اندازد. برای فیلدهایی مثل تنظیمات نقش‌ها که
   * کاربر ممکن است پشت‌سرهم مقدار را تغییر دهد مفید است.
   */
  function debounce(fn, waitMs) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), waitMs);
    };
  }

  /**
   * اعتبارسنجی زودهنگام نام بازیکن/اتاق - دقیقاً هم‌راستا با validateJoinInput
   * سمت سرور. این فقط یک لایه‌ی کمکی برای UX سریع‌تر است؛ سرور همچنان منبع
   * نهایی صحت داده است.
   * @returns {{ok: boolean, message?: string}}
   */
  function clientValidateJoinInput(username, roomName) {
    const trimmedUsername = (username || '').trim();
    const trimmedRoom = (roomName || '').trim();
    if (trimmedUsername.length < VALIDATION.MIN_USERNAME_LEN) {
      return { ok: false, message: `نام بازیکن باید حداقل ${VALIDATION.MIN_USERNAME_LEN} کاراکتر باشد.` };
    }
    if (trimmedUsername.length > VALIDATION.MAX_USERNAME_LEN) {
      return { ok: false, message: `نام بازیکن نباید بیشتر از ${VALIDATION.MAX_USERNAME_LEN} کاراکتر باشد.` };
    }
    if (trimmedRoom.length < VALIDATION.MIN_ROOMNAME_LEN) {
      return { ok: false, message: `نام اتاق باید حداقل ${VALIDATION.MIN_ROOMNAME_LEN} کاراکتر باشد.` };
    }
    if (trimmedRoom.length > VALIDATION.MAX_ROOMNAME_LEN) {
      return { ok: false, message: `نام اتاق نباید بیشتر از ${VALIDATION.MAX_ROOMNAME_LEN} کاراکتر باشد.` };
    }
    return { ok: true };
  }

  /**
   * اعتبارسنجی زودهنگام تنظیمات نقش‌ها - آینه‌ای از validateRolesConfig سمت
   * سرور. تعداد کل نقش‌ها باید دقیقاً برابر تعداد بازیکنان باشد، حداقل یک
   * نفر عضو تیم مافیا باشد، تیم مافیا نباید نصف یا بیشتر از کل باشد، و
   * حداکثر یک رئیس مافیا مجاز است.
   * @returns {{ok: boolean, message?: string, total: number}}
   */
  function clientValidateRolesConfig(rolesConfig, playerCount) {
    const total =
      (rolesConfig.mafia_boss || 0) +
      (rolesConfig.mafia || 0) +
      (rolesConfig.doctor_lecter || 0) +
      (rolesConfig.doctor || 0) +
      (rolesConfig.detective || 0) +
      (rolesConfig.saqi || 0) +
      (rolesConfig.natasha || 0) +
      (rolesConfig.sniper || 0) +
      (rolesConfig.citizen || 0);

    if (total !== playerCount) {
      return {
        ok: false,
        total,
        message: `مجموع نقش‌ها (${total}) باید دقیقاً برابر تعداد بازیکنان (${playerCount}) باشد.`,
      };
    }
    const mafiaTeamCount = (rolesConfig.mafia_boss || 0) + (rolesConfig.mafia || 0) + (rolesConfig.doctor_lecter || 0);
    if (mafiaTeamCount < 1) {
      return { ok: false, total, message: 'حداقل باید یک نفر عضو تیم مافیا باشد.' };
    }
    if (mafiaTeamCount * 2 >= playerCount) {
      return { ok: false, total, message: 'تعداد اعضای تیم مافیا نسبت به کل بازیکنان بیش از حد زیاد است.' };
    }
    if ((rolesConfig.mafia_boss || 0) > 1) {
      return { ok: false, total, message: 'حداکثر یک نفر می‌تواند رئیس مافیا باشد.' };
    }
    return { ok: true, total };
  }

  // ---------------- localStorage: به‌خاطرسپاری نام بازیکن (اختیاری) ----------------
  // توجه: این ویژگی مخصوص اجرای مستقل این وب‌اپ در مرورگر خود کاربر است
  // (نه محیط پیش‌نمایش Artifact) و صرفاً برای راحتی کاربر است؛ نبود آن هیچ
  // اختلالی در عملکرد بازی ایجاد نمی‌کند.

  function rememberUsername(username) {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEYS.USERNAME, username);
    } catch (err) {
      // برخی مرورگرها/حالت‌های خصوصی ممکن است اجازه‌ی localStorage ندهند؛ بی‌خطر نادیده گرفته می‌شود.
    }
  }

  function loadRememberedUsername() {
    try {
      return window.localStorage.getItem(LOCAL_STORAGE_KEYS.USERNAME) || '';
    } catch (err) {
      return '';
    }
  }

  // ---------------- لینک دعوت (query params) ----------------

  /** نام اتاق را از query string فعلی می‌خواند تا لینک دعوت پیش‌پر شود. */
  function readRoomNameFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('room') || '';
    } catch (err) {
      return '';
    }
  }

  /** آدرس صفحه را طوری به‌روزرسانی می‌کند که شامل نام اتاق فعلی باشد (برای اشتراک‌گذاری). */
  function updateUrlForRoom(roomName) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomName);
      window.history.replaceState({}, '', url.toString());
    } catch (err) {
      // اگر History API در دسترس نبود، بی‌خطر نادیده بگیر.
    }
  }

  /** لینک کامل دعوت (شامل نام اتاق) را برمی‌گرداند تا در کلیپ‌بورد کپی شود. */
  function buildInviteLink(roomName) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomName);
      return url.toString();
    } catch (err) {
      return roomName;
    }
  }

  /**
   * دکمه را بلافاصله پس از کلیک غیرفعال می‌کند تا از ارسال چندباره‌ی یک
   * رویداد به‌خاطر دابل‌کلیک یا لرزش شبکه جلوگیری شود، سپس رویداد را ارسال
   * می‌کند. اگر پاسخ سرور (موفق یا خطا) دیر برسد، پس از fallbackMs به‌صورت
   * خودکار دوباره فعال می‌شود تا کاربر هیچ‌وقت در یک دکمه‌ی گیر‌کرده متوقف نماند.
   */
  function guardedEmit(button, eventName, payload, fallbackMs) {
    if (!button || button.disabled) return;
    button.disabled = true;
    clientState.socket.emit(eventName, payload);
    setTimeout(() => {
      button.disabled = false;
    }, fallbackMs || 4000);
  }

  // ==========================================================================
  // بخش ۵: مدیریت نمایش View ها
  // ==========================================================================

  /**
   * فقط یکی از سه ویوی اصلی (login/lobby/game) را نمایش می‌دهد و بقیه را
   * مخفی می‌کند. این تنها نقطه‌ای است که ویوی فعال را عوض می‌کند تا رفتار
   * ناوبری قابل پیش‌بینی بماند.
   * @param {'login'|'lobby'|'game'} name
   */
  function showView(name) {
    hide(dom.viewLogin);
    hide(dom.viewLobby);
    hide(dom.viewGame);
    if (name === 'login') show(dom.viewLogin);
    if (name === 'lobby') show(dom.viewLobby);
    if (name === 'game') show(dom.viewGame);
  }

  /** نوار وضعیت اتصال بالای صفحه را به‌روزرسانی می‌کند (رنگ نقطه از data-state در style.css می‌آید). */
  function setConnectionState(state, text) {
    if (!dom.connectionStatus) return;
    dom.connectionStatus.dataset.state = state;
    setText(dom.connectionStatusText, text);
  }

  // ==========================================================================
  // بخش ۶: لاگ سیستمی (system_message) - در هر دو ویو (لابی/بازی) نمایش داده می‌شود
  // ==========================================================================

  /**
   * یک خط جدید به لاگ رویدادها اضافه می‌کند. چون لابی و بازی دو ظرف لاگ
   * جدا دارند (lobby-system-log و game-system-log) و ممکن است هرکدام در
   * لحظه‌ی دریافت پیام مخفی باشند، پیام در هر دو درج می‌شود تا تاریخچه‌ی
   * کامل حفظ شود؛ طول لیست هم به MAX_LOG_ITEMS محدود می‌شود تا DOM سنگین نشود.
   */
  function appendLogEntry(text, ts) {
    [dom.lobbySystemLog, dom.gameSystemLog].forEach((container) => {
      if (!container || !dom.tplLogItem) return;
      const frag = dom.tplLogItem.content.cloneNode(true);
      const li = frag.querySelector('.log-item');
      li.querySelector('.log-time').textContent = formatClock(ts);
      li.querySelector('.log-text').textContent = text;
      container.prepend(li);
      while (container.children.length > MAX_LOG_ITEMS) {
        container.removeChild(container.lastChild);
      }
    });
  }

  // ==========================================================================
  // بخش ۷: کمک‌کننده‌های مربوط به بازیکن جاری (you) و اتاق
  // ==========================================================================

  /** آبجکت خودِ بازیکن را از room.players فعلی برمی‌گرداند (یا null). */
  function getMe() {
    if (!clientState.room || !clientState.you) return null;
    return clientState.room.players.find((p) => p.id === clientState.you.id) || null;
  }

  /** آیا بازیکن جاری هاست این اتاق است؟ برای تعیین نمایش دکمه‌های مدیریتی استفاده می‌شود. */
  function isHost() {
    const me = getMe();
    return !!(me && me.isHost);
  }

  /** لیست بازیکنان زنده به‌جز خودِ کاربر - برای ساخت گزینه‌های هدف شب/رأی‌گیری. */
  function alivePlayersExcludingMe() {
    if (!clientState.room) return [];
    const myId = clientState.you && clientState.you.id;
    return clientState.room.players.filter((p) => p.isAlive && p.id !== myId);
  }

  // ==========================================================================
  // بخش ۸: رندر لیست بازیکنان (مشترک بین لابی و بازی)
  // ==========================================================================

  /** نشان‌های کوچک (هاست/آماده/میکروفون‌قطع/در‌ویس/قطع‌شده) را برای یک بازیکن رندر می‌کند. */
  function renderPlayerBadges(container, player) {
    clearChildren(container);
    const addBadge = (text, cls) => {
      const span = document.createElement('span');
      span.className = `badge ${cls}`;
      span.textContent = text;
      container.appendChild(span);
    };
    if (player.isHost) addBadge('هاست', 'badge-host');
    if (clientState.room && clientState.room.phase === PHASES.LOBBY) {
      addBadge(player.isReady ? 'آماده' : 'در انتظار', player.isReady ? 'badge-ready' : '');
    }
    if (player.isMuted && player.inVoice) addBadge('میکروفون قطع', 'badge-muted');
    if (player.inVoice) addBadge('در ویس', '');
    if (!player.connected) addBadge('قطع‌شده', '');
  }

  /**
   * لیست بازیکنان را داخل یک <ul> رندر می‌کند. اگر لیست خالی باشد، یک پیام
   * جایگزین نمایش می‌دهد تا کاربر با یک ناحیه‌ی خالی و مبهم روبه‌رو نشود.
   */
  function renderPlayerList(container, players) {
    if (!container || !dom.tplPlayerItem) return;
    clearChildren(container);

    if (!players || players.length === 0) {
      const li = document.createElement('li');
      li.className = 'hint-text';
      li.textContent = 'هنوز بازیکنی در اتاق نیست.';
      container.appendChild(li);
      return;
    }

    players.forEach((player) => {
      const frag = dom.tplPlayerItem.content.cloneNode(true);
      const li = frag.querySelector('.player-item');
      li.dataset.playerId = player.id;
      li.dataset.alive = String(player.isAlive);
      li.dataset.connected = String(player.connected);
      li.dataset.speaking = String(!!clientState.speakingState.get(player.id));
      li.querySelector('.player-name').textContent = player.username + (player.id === (clientState.you && clientState.you.id) ? ' (شما)' : '');
      renderPlayerBadges(li.querySelector('.player-badges'), player);
      container.appendChild(li);
    });
  }

  /** هر دو لیست بازیکنان (لابی و بازی) را با آخرین room همگام می‌کند. */
  function refreshAllPlayerLists() {
    if (!clientState.room) return;
    renderPlayerList(dom.lobbyPlayerList, clientState.room.players);
    renderPlayerList(dom.gamePlayerList, clientState.room.players);
  }

  /**
   * وضعیت «در حال صحبت» یک peer را روی تمام کارت‌های بازیکن با همان id
   * (که ممکن است هم در لابی و هم در بازی رندر شده باشند) اعمال می‌کند.
   */
  function updateSpeakingIndicator(peerId, isSpeaking) {
    clientState.speakingState.set(peerId, isSpeaking);
    document.querySelectorAll(`.player-item[data-player-id="${peerId}"]`).forEach((elItem) => {
      elItem.dataset.speaking = String(isSpeaking);
    });
  }

  // ==========================================================================
  // بخش ۹: رندر لابی
  // ==========================================================================

  /**
   * کل صفحه‌ی لابی را از روی clientState.room بازسازی می‌کند: نام اتاق،
   * شمارش آماده‌ها، لیست بازیکنان، دکمه‌ی آماده/هاست، و پنل تنظیمات نقش‌ها
   * که فقط برای هاست نمایش داده می‌شود.
   */
  function renderLobby() {
    const room = clientState.room;
    if (!room) return;

    setText(dom.lobbyRoomName, room.id);
    const readyCount = room.players.filter((p) => p.isReady).length;
    setText(dom.lobbyPlayerCount, `${room.players.length} بازیکن · ${readyCount} آماده`);

    refreshAllPlayerLists();

    const me = getMe();
    const amHost = !!(me && me.isHost);

    // دکمه‌ی آماده/هاست
    if (me) {
      if (amHost) {
        hide(dom.btnToggleReady);
        show(dom.lobbyReadyHint);
      } else {
        show(dom.btnToggleReady);
        hide(dom.lobbyReadyHint);
        setText(dom.btnToggleReady, me.isReady ? 'آماده‌ام ✔' : 'آماده‌ام');
        dom.btnToggleReady.classList.toggle('btn-secondary', !me.isReady);
        dom.btnToggleReady.classList.toggle('btn-primary', me.isReady);
      }
    }

    // تنظیمات نقش‌ها و دکمه‌ی شروع فقط برای هاست
    if (amHost) {
      show(dom.lobbyRolesConfig);
      show(dom.btnStartGame);
      if (room.rolesConfig) {
        dom.roleCountMafiaBoss.value = room.rolesConfig.mafia_boss ?? 0;
        dom.roleCountMafia.value = room.rolesConfig.mafia ?? 0;
        dom.roleCountDoctorLecter.value = room.rolesConfig.doctor_lecter ?? 0;
        dom.roleCountDoctor.value = room.rolesConfig.doctor ?? 0;
        dom.roleCountDetective.value = room.rolesConfig.detective ?? 0;
        dom.roleCountSaqi.value = room.rolesConfig.saqi ?? 0;
        dom.roleCountNatasha.value = room.rolesConfig.natasha ?? 0;
        dom.roleCountSniper.value = room.rolesConfig.sniper ?? 0;
        dom.roleCountCitizen.value = room.rolesConfig.citizen ?? 0;
      }
      updateRolesConfigTotal();

      const readiness = computeStartGameReadiness();
      dom.btnStartGame.disabled = !readiness.ok;
      setText(dom.lobbyStartError, readiness.ok ? '' : readiness.message);
    } else {
      hide(dom.lobbyRolesConfig);
      hide(dom.btnStartGame);
    }
  }

  /**
   * پیش از فراخوانی سرور، همان قوانین startGame سمت سرور را (تعداد کافی
   * بازیکن + همه غیرهاست‌ها آماده باشند) به‌صورت محلی بررسی می‌کند تا هاست
   * دکمه‌ی غیرفعال را ببیند و بداند چرا، به‌جای اینکه فقط بعد از کلیک خطا بگیرد.
   * اعتبارسنجی قطعی نقش‌ها (rolesConfig) همچنان توسط سرور در لحظه‌ی start_game
   * انجام می‌شود.
   * @returns {{ok: boolean, message?: string}}
   */
  function computeStartGameReadiness() {
    const room = clientState.room;
    if (!room) return { ok: false, message: '' };

    const connected = room.players.filter((p) => p.connected);
    if (connected.length < VALIDATION.MIN_PLAYERS_TO_START) {
      return {
        ok: false,
        message: `حداقل ${VALIDATION.MIN_PLAYERS_TO_START} بازیکن برای شروع لازم است (اکنون ${connected.length} نفر).`,
      };
    }

    const notReady = connected.filter((p) => !p.isReady && !p.isHost);
    if (notReady.length > 0) {
      return {
        ok: false,
        message: `در انتظار آماده‌شدن: ${notReady.map((p) => p.username).join('، ')}`,
      };
    }

    return { ok: true };
  }

  /** مقدار فعلی هر ۹ ورودی نقش را از DOM می‌خواند و یک آبجکت rolesConfig می‌سازد. */
  function readRolesConfigFromInputs() {
    return {
      mafia_boss: Number(dom.roleCountMafiaBoss.value || 0),
      mafia: Number(dom.roleCountMafia.value || 0),
      doctor_lecter: Number(dom.roleCountDoctorLecter.value || 0),
      doctor: Number(dom.roleCountDoctor.value || 0),
      detective: Number(dom.roleCountDetective.value || 0),
      saqi: Number(dom.roleCountSaqi.value || 0),
      natasha: Number(dom.roleCountNatasha.value || 0),
      sniper: Number(dom.roleCountSniper.value || 0),
      citizen: Number(dom.roleCountCitizen.value || 0),
    };
  }

  /**
   * مجموع نقش‌های وارد‌شده توسط هاست را محاسبه و با clientValidateRolesConfig
   * می‌سنجد؛ در صورت نامعتبر بودن، پیام خطا نمایش داده شده و دکمه‌های
   * «ذخیره‌ی تنظیمات» و «شروع بازی» غیرفعال می‌شوند تا کاربر پیش از رفتن به
   * سرور از مشکل مطلع باشد (اعتبارسنجی نهایی همچنان سمت سرور است).
   */
  function updateRolesConfigTotal() {
    const rolesConfig = readRolesConfigFromInputs();
    const playerCount = clientState.room ? clientState.room.players.length : 0;
    const validation = clientValidateRolesConfig(rolesConfig, playerCount);

    if (validation.ok) {
      setText(dom.rolesConfigTotal, `مجموع نقش‌ها: ${validation.total} از ${playerCount} بازیکن ✔`);
      dom.rolesConfigTotal.style.color = '';
      dom.btnSaveRoles.disabled = false;
    } else {
      setText(dom.rolesConfigTotal, validation.message);
      dom.rolesConfigTotal.style.color = 'var(--accent-blood-bright)';
      dom.btnSaveRoles.disabled = true;
    }
  }

  /**
   * همان قاعده‌ی buildDefaultRolesConfig سمت سرور را در کلاینت اجرا می‌کند
   * تا هاست بتواند پیش از ارسال، یک پیشنهاد منطقی ببیند. اگر سرور این قاعده
   * را تغییر دهد، باید اینجا هم به‌روزرسانی شود.
   */
  function applyAutoRolesConfig() {
    const playerCount = clientState.room ? clientState.room.players.length : 0;

    const mafiaTeamTotal = Math.max(1, Math.floor(playerCount / 4));
    const mafiaBossCount = playerCount >= 4 ? 1 : 0;
    let mafiaSlotsLeft = mafiaTeamTotal - mafiaBossCount;
    const doctorLecterCount = playerCount >= 6 && mafiaSlotsLeft >= 1 ? 1 : 0;
    mafiaSlotsLeft -= doctorLecterCount;
    const mafiaCount = Math.max(0, mafiaSlotsLeft);

    const config = {
      mafia_boss: mafiaBossCount,
      mafia: mafiaCount,
      doctor_lecter: doctorLecterCount,
      doctor: 0,
      detective: 0,
      saqi: 0,
      natasha: 0,
      sniper: 0,
      citizen: 0,
    };
    let remaining = playerCount - (mafiaBossCount + mafiaCount + doctorLecterCount);

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

    dom.roleCountMafiaBoss.value = config.mafia_boss;
    dom.roleCountMafia.value = config.mafia;
    dom.roleCountDoctorLecter.value = config.doctor_lecter;
    dom.roleCountDoctor.value = config.doctor;
    dom.roleCountDetective.value = config.detective;
    dom.roleCountSaqi.value = config.saqi;
    dom.roleCountNatasha.value = config.natasha;
    dom.roleCountSniper.value = config.sniper;
    dom.roleCountCitizen.value = config.citizen;
    updateRolesConfigTotal();
  }

  // ==========================================================================
  // بخش ۱۰: رندر بنر فاز بازی
  // ==========================================================================

  /** رنگ و متن بنر بالای صفحه‌ی بازی را بر اساس فاز جاری تنظیم می‌کند (رنگ‌ها در style.css با data-phase مشخص شده‌اند). */
  function renderPhaseBanner(phase, dayNumber) {
    if (!dom.gamePhaseBanner) return;
    dom.gamePhaseBanner.dataset.phase = phase;
    setText(dom.gamePhaseLabel, PHASE_LABELS[phase] || phase);
    setText(dom.gamePhaseDay, dayNumber ? `روز/شب شماره‌ی ${dayNumber}` : '');
  }

  // ==========================================================================
  // بخش ۱۱: رندر فاز شب - پنل نقش‌محور
  // ==========================================================================

  /** هر چهار پنل فاز (شب/روز/رأی‌گیری/نتیجه) را مخفی می‌کند؛ applyPhaseChange دقیقاً یکی را دوباره نمایش می‌دهد. */
  function hideAllPhasePanels() {
    hide(dom.panelNight);
    hide(dom.panelDay);
    hide(dom.panelVoting);
    hide(dom.panelDefense);
    hide(dom.panelResults);
  }

  /**
   * یک شبکه از دکمه‌های هدف (برای شب/رأی‌گیری) می‌سازد. از tpl-target-button
   * کلون می‌گیرد تا ساختار HTML یک‌جا کنترل شود. options.onSelect با id هدف
   * انتخاب‌شده (یا null برای «رأی سفید/بدون اقدام») فراخوانی می‌شود.
   * @param {HTMLElement} container
   * @param {Array} candidates لیست بازیکنانی که می‌توان انتخابشان کرد
   * @param {{selectedId: (string|null|undefined), disabled: boolean, allowSkip: boolean, skipLabel?: string, onSelect: Function}} options
   */
  function buildTargetButtons(container, candidates, options) {
    clearChildren(container);
    if (!dom.tplTargetButton) return;
    candidates.forEach((player) => {
      const frag = dom.tplTargetButton.content.cloneNode(true);
      const btn = frag.querySelector('.target-btn');
      btn.querySelector('.target-name').textContent = player.username;
      btn.dataset.targetId = player.id;
      if (options.selectedId === player.id) btn.dataset.selected = 'true';
      if (options.disabled) btn.disabled = true;
      btn.addEventListener('click', () => options.onSelect(player.id));
      container.appendChild(btn);
    });
    if (options.allowSkip) {
      const frag = dom.tplTargetButton.content.cloneNode(true);
      const btn = frag.querySelector('.target-btn');
      btn.querySelector('.target-name').textContent = options.skipLabel || 'رأی سفید / بدون اقدام';
      btn.dataset.targetId = '';
      if (options.selectedId === null) btn.dataset.selected = 'true';
      if (options.disabled) btn.disabled = true;
      btn.addEventListener('click', () => options.onSelect(null));
      container.appendChild(btn);
    }
  }

  /**
   * پنل شب را بر اساس نقش خودِ بازیکن رندر می‌کند. فقط یکی از چهار زیرپنل
   * (مافیا/دکتر/کارآگاه/شهروند) نمایش داده می‌شود. اگر بازیکن حذف شده باشد،
   * هیچ پنل اکشنی نشان داده نمی‌شود و فقط پیام انتظار نمایش می‌یابد.
   */
  function renderNightPanel() {
    const me = getMe();
    hide(dom.nightMafiaPanel);
    hide(dom.nightDoctorPanel);
    hide(dom.nightDetectivePanel);
    hide(dom.nightSaqiPanel);
    hide(dom.nightNatashaPanel);
    hide(dom.nightSniperPanel);
    hide(dom.nightCitizenPanel);
    hide(dom.detectiveResultDisplay);
    hide(dom.btnForceResolveNight);
    setText(dom.nightActionStatus, '');

    if (!me) return;

    if (isHost()) show(dom.btnForceResolveNight);

    if (!me.isAlive) {
      setText(dom.nightActionStatus, 'شما حذف شده‌اید و فقط می‌توانید نتیجه را تماشا کنید.');
      return;
    }

    const candidates = alivePlayersExcludingMe();
    const role = clientState.myRole ? clientState.myRole.role : me.role;

    if (role === 'mafia_boss' || role === 'mafia' || role === 'doctor_lecter') {
      renderMafiaTeamNightPanel(role, candidates);
    } else if (role === 'doctor') {
      show(dom.nightDoctorPanel);
      const withSelf = clientState.room.players.filter((p) => p.isAlive);
      buildTargetButtons(dom.nightDoctorTargets, withSelf, {
        selectedId: clientState.nightSelection,
        disabled: clientState.nightActionSent,
        allowSkip: false,
        onSelect: (targetId) => submitNightAction(targetId),
      });
    } else if (role === 'detective') {
      show(dom.nightDetectivePanel);
      buildTargetButtons(dom.nightDetectiveTargets, candidates, {
        selectedId: clientState.nightSelection,
        disabled: clientState.nightActionSent,
        allowSkip: false,
        onSelect: (targetId) => submitNightAction(targetId),
      });
    } else if (role === 'saqi') {
      show(dom.nightSaqiPanel);
      buildTargetButtons(dom.nightSaqiTargets, candidates, {
        selectedId: clientState.nightSelection,
        disabled: clientState.nightActionSent,
        allowSkip: true,
        skipLabel: 'امشب کسی را مست نکن',
        onSelect: (targetId) => submitNightAction(targetId),
      });
    } else if (role === 'natasha') {
      show(dom.nightNatashaPanel);
      buildTargetButtons(dom.nightNatashaTargets, candidates, {
        selectedId: clientState.nightSelection,
        disabled: clientState.nightActionSent,
        allowSkip: true,
        skipLabel: 'امشب کسی را سایلنت نکن',
        onSelect: (targetId) => submitNightAction(targetId),
      });
    } else if (role === 'sniper') {
      show(dom.nightSniperPanel);
      const bullets = me.sniperBulletsRemaining ?? 0;
      setText(dom.sniperBulletsRemaining, `تیر باقی‌مانده: ${bullets}`);
      if (bullets <= 0) {
        setText(dom.nightActionStatus, 'تیری برای شما باقی نمانده است.');
        clearChildren(dom.nightSniperTargets);
      } else {
        buildTargetButtons(dom.nightSniperTargets, candidates, {
          selectedId: clientState.nightSelection,
          disabled: clientState.nightActionSent,
          allowSkip: true,
          skipLabel: 'امشب شلیک نکن',
          onSelect: (targetId) => submitNightAction(targetId),
        });
      }
    } else {
      show(dom.nightCitizenPanel);
    }
  }

  /**
   * پنل مشترک تیم مافیا: رئیس مافیا هدف نهایی را انتخاب می‌کند؛ مافیای ساده
   * فقط وقتی رئیس زنده نباشد گزینه‌ی انتخاب هدف می‌بیند (وگرنه منتظر می‌ماند)؛
   * دکتر لکتر فقط می‌تواند از بین هم‌تیمی‌های مافیا برای محافظت انتخاب کند.
   */
  function renderMafiaTeamNightPanel(role, candidates) {
    show(dom.nightMafiaPanel);

    const teammates = clientState.mafiaTeammates || [];
    const bossInTeam = teammates.some((t) => t.role === 'mafia_boss');
    const teammateNames = teammates.map((t) => `${t.username} (${ROLE_LABELS[t.role] || t.role})`);
    setText(
      dom.nightMafiaTeammates,
      teammateNames.length > 0 ? `هم‌تیمی‌های شما: ${teammateNames.join('، ')}` : 'شما تنها عضو زنده‌ی تیم مافیا هستید.'
    );

    if (role === 'mafia_boss') {
      setText(dom.nightMafiaRoleFlavor, 'شما رئیس مافیا هستید. تصمیم نهایی برای هدف امشب با شماست.');
      buildTargetButtons(dom.nightMafiaTargets, candidates, {
        selectedId: clientState.nightSelection,
        disabled: clientState.nightActionSent,
        allowSkip: false,
        onSelect: (targetId) => submitNightAction(targetId),
      });
    } else if (role === 'mafia') {
      if (bossInTeam) {
        setText(dom.nightMafiaRoleFlavor, 'رئیس مافیا زنده است؛ منتظر تصمیم نهایی او بمانید.');
        clearChildren(dom.nightMafiaTargets);
      } else {
        setText(
          dom.nightMafiaRoleFlavor,
          'رئیس مافیا زنده نیست؛ هدف امشب با اجماع شما و بقیه‌ی مافیای ساده تعیین می‌شود.'
        );
        buildTargetButtons(dom.nightMafiaTargets, candidates, {
          selectedId: clientState.nightSelection,
          disabled: clientState.nightActionSent,
          allowSkip: false,
          onSelect: (targetId) => submitNightAction(targetId),
        });
      }
    } else if (role === 'doctor_lecter') {
      setText(
        dom.nightMafiaRoleFlavor,
        'یکی از هم‌تیمی‌های مافیا را برای محافظت در برابر شلیک تک‌تیرانداز انتخاب کنید.'
      );
      const mafiaTeammateCandidates = teammates.map((t) => ({ id: t.id, username: t.username }));
      buildTargetButtons(dom.nightMafiaTargets, mafiaTeammateCandidates, {
        selectedId: clientState.nightSelection,
        disabled: clientState.nightActionSent,
        allowSkip: true,
        skipLabel: 'امشب کسی را محافظت نکن',
        onSelect: (targetId) => submitNightAction(targetId),
      });
    }
  }

  function submitNightAction(targetId) {
    clientState.nightSelection = targetId;
    clientState.socket.emit(EVT.NIGHT_ACTION, { targetId });
  }

  /**
   * نتیجه‌ی هر استعلام کارآگاه را به تاریخچه اضافه می‌کند (به‌جای overwrite
   * کردن نتیجه‌ی قبلی) چون کارآگاه ممکن است در چند شب متوالی استعلام بگیرد
   * و دیدن تاریخچه به تصمیم‌گیری روزهای بعد کمک می‌کند.
   */
  function appendDetectiveResult(targetUsername, team) {
    const dayNumber = clientState.room ? clientState.room.dayNumber : null;
    clientState.detectiveHistory.push({ targetUsername, team, dayNumber });

    show(dom.detectiveResultDisplay);
    clearChildren(dom.detectiveResultDisplay);
    clientState.detectiveHistory.forEach((entry) => {
      const line = document.createElement('div');
      line.textContent = `شب ${entry.dayNumber ?? '?'}: ${entry.targetUsername} عضو ${
        TEAM_LABELS[entry.team] || entry.team
      } است.`;
      dom.detectiveResultDisplay.appendChild(line);
    });
  }

  // ==========================================================================
  // بخش ۱۲: رندر فاز روز
  // ==========================================================================

  /** فقط دکمه‌ی «شروع رأی‌گیری» را برای هاست نشان می‌دهد؛ بقیه منتظر می‌مانند. */
  /** فقط دکمه‌ی «شروع رأی‌گیری» را برای هاست نشان می‌دهد؛ بقیه منتظر می‌مانند. */
  function renderDayPanel() {
    if (isHost()) {
      show(dom.btnAdvanceVoting);
    } else {
      hide(dom.btnAdvanceVoting);
    }

    const me = getMe();
    const iAmSilenced = !!(me && clientState.room && clientState.room.silencedPlayerId === me.id);
    if (iAmSilenced) {
      show(dom.daySilencedNotice);
      setText(dom.daySilencedNotice, 'دیشب توسط ناتاشا سایلنت شدید و امروز نمی‌توانید صحبت کنید.');
    } else {
      hide(dom.daySilencedNotice);
    }
  }

  // ==========================================================================
  // بخش ۱۳: رندر فاز رأی‌گیری
  // ==========================================================================

  /**
   * دکمه‌های رأی‌گیری را برای بازیکنان زنده (به‌جز خود) رندر می‌کند، به‌علاوه
   * گزینه‌ی «رأی سفید». اگر خود بازیکن حذف شده باشد، به‌جای دکمه‌ها پیام
   * می‌بینیم که اجازه‌ی رأی ندارد.
   */
  function renderVotingPanel() {
    const me = getMe();
    setText(dom.voteError, '');
    if (isHost()) show(dom.btnEndVoting);
    else hide(dom.btnEndVoting);

    if (!me || !me.isAlive) {
      clearChildren(dom.votingCandidateList);
      const p = document.createElement('p');
      p.className = 'hint-text';
      p.textContent = 'شما حذف شده‌اید و نمی‌توانید رأی دهید.';
      dom.votingCandidateList.appendChild(p);
      return;
    }

    const candidates = clientState.room.players.filter((p) => p.isAlive && p.id !== me.id);
    buildTargetButtons(dom.votingCandidateList, candidates, {
      selectedId: clientState.myVoteTargetId,
      disabled: false,
      allowSkip: true,
      skipLabel: 'رأی سفید',
      onSelect: (targetId) => submitDayVote(targetId),
    });
  }

  /** رأی روز را به سرور می‌فرستد؛ overwrite مجاز است تا پایان فاز رأی‌گیری (سرور هم همین قانون را دارد). */
  function submitDayVote(targetId) {
    clientState.myVoteTargetId = targetId;
    clientState.socket.emit(EVT.DAY_VOTE, { targetId });
    renderVotingPanel();
    stopTitleAlert();
  }

  /** جدول خلاصه‌ی آرا (کی چند رأی دارد) را از payload سرور رندر می‌کند. */
  function renderVoteTally(tally) {
    clearChildren(dom.votingTallyDisplay);
    if (!tally || Object.keys(tally).length === 0) {
      const p = document.createElement('p');
      p.textContent = 'هنوز رأیی ثبت نشده است.';
      dom.votingTallyDisplay.appendChild(p);
      return;
    }
    Object.entries(tally).forEach(([targetId, count]) => {
      const player = clientState.room.players.find((p) => p.id === targetId);
      const row = document.createElement('div');
      row.className = 'vote-tally-row';
      const name = document.createElement('span');
      name.textContent = player ? player.username : 'ناشناس';
      const countEl = document.createElement('span');
      countEl.textContent = `${count} رأی`;
      row.appendChild(name);
      row.appendChild(countEl);
      dom.votingTallyDisplay.appendChild(row);
    });
  }

  // ==========================================================================
  // بخش ۱۳.۵: رندر فاز دفاعیه
  // ==========================================================================

  /**
   * فاز دفاعیه را نمایش می‌دهد: خودِ متهم پیام «شما در حال دفاع هستید» و
   * میکروفونش باز می‌بیند؛ بقیه پیام «در حال شنیدن دفاعیه» و میکروفونشان
   * قفل می‌شود. شمارش معکوس صرفاً بصری است؛ پایان واقعی فاز را سرور با
   * رویداد defense_ended یا phase_changed بعدی تعیین می‌کند.
   */
  function renderDefensePanel({ defendantId, defendantUsername, durationMs }) {
    clientState.defendantId = defendantId;
    const me = clientState.you;
    const isDefendant = !!(me && me.id === defendantId);

    if (isHost()) show(dom.btnEndDefense);
    else hide(dom.btnEndDefense);

    setText(
      dom.defenseMessage,
      isDefendant
        ? 'شما با نصف یا بیشتر آرا مواجه شدید. الان نوبت شماست تا از خودتان دفاع کنید.'
        : `${defendantUsername} در حال دفاع از خودش است. لطفاً ساکت باشید و گوش دهید.`
    );
    setText(
      dom.defenseMicNotice,
      isDefendant ? 'میکروفون شما باز است.' : 'میکروفون شما تا پایان دفاعیه قفل است.'
    );

    if (isDefendant) forceUnmuteSelf();

    startDefenseCountdown(durationMs || 75000);
  }

  function startDefenseCountdown(durationMs) {
    clearDefenseCountdown();
    clientState.defenseEndsAt = Date.now() + durationMs;

    const tick = () => {
      const remainingMs = clientState.defenseEndsAt - Date.now();
      if (remainingMs <= 0) {
        setText(dom.defenseCountdown, '۰۰:۰۰');
        clearDefenseCountdown();
        return;
      }
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const ss = String(totalSeconds % 60).padStart(2, '0');
      setText(dom.defenseCountdown, `${mm}:${ss}`);
    };

    tick();
    clientState.defenseCountdownInterval = setInterval(tick, 250);
  }

  function clearDefenseCountdown() {
    if (clientState.defenseCountdownInterval) {
      clearInterval(clientState.defenseCountdownInterval);
      clientState.defenseCountdownInterval = null;
    }
  }

  // ==========================================================================
  // بخش ۱۴: Overlay نتیجه (شب/رأی‌گیری)
  // ==========================================================================

  /**
   * پیام کوتاهی از نتیجه‌ی شب یا رأی‌گیری را برای durationMs میلی‌ثانیه نشان
   * می‌دهد. اگر phase_changed در همین بازه برسد (که طبق رفتار سرور معمولاً
   * بلافاصله بعد از night_result/voting_result می‌رسد)، اعمال آن تا پایان
   * تایمر به تعویق می‌افتد تا کاربر فرصت خواندن نتیجه را داشته باشد.
   */
  function showResultsOverlay(message, durationMs) {
    hideAllPhasePanels();
    show(dom.panelResults);
    setText(dom.resultsMessage, message);
    clientState.resultsOverlayActive = true;

    if (clientState.resultsOverlayTimer) clearTimeout(clientState.resultsOverlayTimer);
    clientState.resultsOverlayTimer = setTimeout(() => {
      clientState.resultsOverlayActive = false;
      clientState.resultsOverlayTimer = null;
      if (clientState.queuedPhasePayload) {
        const payload = clientState.queuedPhasePayload;
        clientState.queuedPhasePayload = null;
        applyPhaseChange(payload);
      }
    }, durationMs || 3500);
  }

  // ==========================================================================
  // بخش ۱۵: اعمال تغییر فاز روی UI
  // ==========================================================================

  /**
   * بنر فاز را به‌روزرسانی و دقیقاً پنل متناظر با فاز جدید را نمایش می‌دهد.
   * این تابع تنها از سمت handlePhaseChanged (مستقیم یا بعد از overlay
   * نتیجه) فراخوانی می‌شود تا هیچ‌گاه دو پنل هم‌زمان نمایش داده نشوند.
   */
  function applyPhaseChange(payload) {
    const { phase, dayNumber } = payload;
    renderPhaseBanner(phase, dayNumber);
    hideAllPhasePanels();
    clearDefenseCountdown();

    if (phase === PHASES.NIGHT) {
      clientState.nightSelection = null;
      clientState.nightActionSent = false;
      show(dom.panelNight);
      renderNightPanel();
    } else if (phase === PHASES.DAY) {
      show(dom.panelDay);
      renderDayPanel();
    } else if (phase === PHASES.VOTING) {
      clientState.myVoteTargetId = undefined;
      show(dom.panelVoting);
      renderVotingPanel();
      renderVoteTally({});
    } else if (phase === PHASES.DEFENSE) {
      show(dom.panelDefense);
      // متن و شمارش معکوس توسط رویداد defense_started پر می‌شود که بلافاصله بعد می‌رسد.
    } else if (phase === PHASES.RESULTS) {
      show(dom.panelResults);
    }
    // role_reveal و ended جداگانه توسط مودال‌های اختصاصی مدیریت می‌شوند

    updateForcedMuteForPhase(phase);
    maybeAlertForMyTurn(phase);
  }

  /** ورودی event phase_changed از سرور؛ اگر overlay نتیجه فعال باشد صف می‌شود، وگرنه فوراً اعمال می‌شود. */
  function handlePhaseChanged(payload) {
    if (clientState.resultsOverlayActive) {
      clientState.queuedPhasePayload = payload;
      return;
    }
    applyPhaseChange(payload);
  }

  // ==========================================================================
  // بخش ۱۶: مودال نقش خصوصی
  // ==========================================================================

  /** مودال نقش خصوصی را با اطلاعات دریافتی از رویداد your_role پر و نمایش می‌دهد. */
  function showRoleRevealModal(payload) {
    clientState.myRole = payload;
    setText(dom.roleRevealName, payload.displayName || ROLE_LABELS[payload.role] || payload.role);
    setText(dom.roleRevealTeam, TEAM_LABELS[payload.team] || payload.team);
    setText(dom.roleRevealDesc, payload.description || '');
    show(dom.modalRoleReveal);
  }

  function hideRoleRevealModal() {
    hide(dom.modalRoleReveal);
  }

  // ==========================================================================
  // بخش ۱۷: مودال پایان بازی
  // ==========================================================================

  /**
   * مودال پایان بازی را با برنده، دلیل، و جدول نقش تمام بازیکنان (که سرور
   * فقط در این لحظه فاش می‌کند) پر می‌کند. دکمه‌ی «دور جدید» فقط برای هاست
   * نمایش داده می‌شود.
   */
  function showGameOverModal(payload) {
    const { winner, reason, roles } = payload;
    setText(
      dom.gameOverWinner,
      winner === 'mafia' ? 'مافیا برنده شد! 🔪' : 'شهروندان برنده شدند! 🎉'
    );
    setText(dom.gameOverReason, reason || '');

    clearChildren(dom.gameOverRolesBody);
    if (clientState.room) {
      clientState.room.players.forEach((player) => {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.textContent = player.username;
        const tdRole = document.createElement('td');
        const roleKey = roles ? roles[player.id] : player.role;
        tdRole.textContent = ROLE_LABELS[roleKey] || roleKey || '—';
        tr.appendChild(tdName);
        tr.appendChild(tdRole);
        dom.gameOverRolesBody.appendChild(tr);
      });
    }

    if (isHost()) show(dom.btnPlayAgain);
    else hide(dom.btnPlayAgain);

    show(dom.modalGameOver);
  }

  function hideGameOverModal() {
    hide(dom.modalGameOver);
  }

  // ==========================================================================
  // بخش ۱۸: اتصال Socket.IO و رویدادهای سرور -> کلاینت
  // ==========================================================================

  /**
   * اتصال Socket.IO را برقرار می‌کند و تمام handlerهای رویدادهای سرور->کلاینت
   * را ثبت می‌کند. این تابع تنها نقطه‌ای است که socket.on فراخوانی می‌شود؛
   * نگه‌داشتن همه‌ی این binding ها در یک‌جا، پیدا کردن mismatch احتمالی با
   * قرارداد بالای server.js را ساده می‌کند.
   */
  function initSocket() {
    const socket = io();
    clientState.socket = socket;

    socket.on('connect', handleSocketConnect);
    socket.on('disconnect', handleSocketDisconnect);
    socket.io.on && socket.io.on('reconnect_attempt', () => {
      setConnectionState('connecting', 'در حال اتصال مجدد...');
    });

    socket.on(EVT.JOIN_ERROR, ({ message }) => {
      setText(dom.loginError, message);
      toast(message, 'error');
    });

    socket.on(EVT.JOINED_ROOM, ({ room, you }) => {
      clientState.room = room;
      clientState.you = you;
      setText(dom.loginError, '');
      updateUrlForRoom(room.id);
      showView('lobby');
      renderLobby();
    });

    socket.on(EVT.ROOM_STATE, ({ room }) => {
      clientState.room = room;
      if (room.phase === PHASES.LOBBY) {
        renderLobby();
      } else {
        refreshAllPlayerLists();
        // اگر در حال حاضر پنل شب/رأی‌گیری نمایش داده می‌شود، دوباره رندر شود
        // تا لیست بازیکنان زنده هماهنگ بماند.
        if (!dom.panelNight.classList.contains('hidden')) renderNightPanel();
        if (!dom.panelVoting.classList.contains('hidden')) renderVotingPanel();
      }
    });

    socket.on(EVT.SYSTEM_MESSAGE, ({ text, ts }) => {
      appendLogEntry(text, ts);
    });

    socket.on(EVT.START_GAME_ERROR, ({ message }) => {
      setText(dom.lobbyStartError, message);
      toast(message, 'error');
      dom.btnStartGame.disabled = false;
    });

    socket.on(EVT.YOUR_ROLE, (payload) => {
      showView('game');
      showRoleRevealModal(payload);
    });

    socket.on(EVT.MAFIA_TEAMMATES, ({ teammates }) => {
      clientState.mafiaTeammates = teammates || [];
      // اگر همین الان پنل شب باز است (مثلاً روستر با تأخیر رسید)، دوباره رندر شود.
      if (!dom.panelNight.classList.contains('hidden')) renderNightPanel();
      applyNightVoiceRoutingAll();
    });

    socket.on(EVT.PHASE_CHANGED, (payload) => {
      handlePhaseChanged(payload);
    });

    socket.on(EVT.NIGHT_ACTION_ACK, ({ message }) => {
      clientState.nightActionSent = true;
      renderNightPanel();
      setText(dom.nightActionStatus, message);
      stopTitleAlert();
    });

    socket.on(EVT.NIGHT_ACTION_ERROR, ({ message }) => {
      toast(message, 'error');
      setText(dom.nightActionStatus, message);
    });

    socket.on(EVT.DETECTIVE_RESULT, ({ targetUsername, team }) => {
      appendDetectiveResult(targetUsername, team);
    });

    socket.on(EVT.SAQI_EFFECT, ({ message }) => {
      toast(message, 'info');
      setText(dom.nightActionStatus, message);
    });

    socket.on(EVT.NIGHT_RESULT, ({ deaths, noDeath }) => {
      const message = noDeath
        ? 'دیشب کسی حذف نشد.'
        : `دیشب حذف شدند: ${deaths.map((d) => d.username).join('، ')}`;
      showResultsOverlay(message, 3500);
    });

    socket.on(EVT.VOTE_UPDATE, ({ tally }) => {
      renderVoteTally(tally);
    });

    socket.on(EVT.VOTE_ERROR, ({ message }) => {
      setText(dom.voteError, message);
      toast(message, 'error');
    });

    socket.on(EVT.VOTING_RESULT, ({ eliminated, tie, wentToDefense }) => {
      if (wentToDefense) {
        // فاز دفاعیه فوری و زمان‌بندی‌شده است؛ نیازی به overlay نتیجه نیست -
        // phase_changed(defense) و defense_started بلافاصله از راه می‌رسند.
        return;
      }
      const message = tie
        ? 'رأی‌گیری با تساوی به پایان رسید؛ کسی حذف نشد.'
        : eliminated
        ? `${eliminated.username} با رأی جمعی حذف شد.`
        : 'رأی‌گیری بدون نتیجه‌ی قطعی به پایان رسید.';
      showResultsOverlay(message, 3500);
    });

    socket.on(EVT.DEFENSE_STARTED, (payload) => {
      renderDefensePanel(payload);
    });

    socket.on(EVT.DEFENSE_ENDED, () => {
      clearDefenseCountdown();
    });

    socket.on(EVT.GAME_OVER, (payload) => {
      hideRoleRevealModal();
      showGameOverModal(payload);
      clearDefenseCountdown();
      applyForcedMute(false);
      restoreDayVoiceRoutingAll();
      stopTitleAlert();
    });

    socket.on(EVT.RESET_TO_LOBBY, ({ room }) => {
      clientState.room = room;
      clientState.myRole = null;
      clientState.nightSelection = null;
      clientState.nightActionSent = false;
      clientState.myVoteTargetId = undefined;
      clientState.detectiveHistory = [];
      clientState.mafiaTeammates = [];
      clientState.defendantId = null;
      clearDefenseCountdown();
      applyForcedMute(false);
      restoreDayVoiceRoutingAll();
      hideRoleRevealModal();
      hideGameOverModal();
      showView('lobby');
      renderLobby();
    });

    // ---------------- ویس ----------------
    socket.on(EVT.VOICE_PEER_JOINED, ({ peerId }) => {
      // هیچ اقدام فوری لازم نیست؛ اگر خودمان peer جدید هستیم، ما آفر می‌فرستیم.
      // اگر عضو موجود ویس هستیم، منتظر آفر از سمت peer جدید می‌مانیم.
      void peerId;
    });

    socket.on(EVT.VOICE_PEER_LEFT, ({ peerId }) => {
      cleanupPeer(peerId);
    });

    socket.on(EVT.VOICE_OFFER, async ({ fromId, sdp }) => {
      const pc = getOrCreatePeerConnection(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit(EVT.VOICE_ANSWER, { targetId: fromId, sdp: pc.localDescription });
    });

    socket.on(EVT.VOICE_ANSWER, async ({ fromId, sdp }) => {
      const pc = clientState.peers.get(fromId);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    });

    socket.on(EVT.VOICE_ICE_CANDIDATE, async ({ fromId, candidate }) => {
      const pc = clientState.peers.get(fromId);
      if (!pc || !candidate) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('خطا در افزودن ICE candidate:', err);
      }
    });

    socket.on(EVT.VOICE_MUTE_STATE, ({ peerId, isMuted }) => {
      if (clientState.room) {
        const p = clientState.room.players.find((pl) => pl.id === peerId);
        if (p) p.isMuted = isMuted;
      }
      refreshAllPlayerLists();
    });

    socket.on(EVT.VOICE_SPEAKING_STATE, ({ peerId, isSpeaking }) => {
      updateSpeakingIndicator(peerId, isSpeaking);
    });
  }

  // ==========================================================================
  // بخش ۱۹: فرم ورود (Login)
  // ==========================================================================

  function wireLoginForm() {
    // پیش‌پر کردن فرم از لینک دعوت (?room=...) و نام به‌خاطرسپرده‌شده
    const rememberedUsername = loadRememberedUsername();
    const roomFromUrl = readRoomNameFromUrl();
    if (rememberedUsername) dom.inputUsername.value = rememberedUsername;
    if (roomFromUrl) dom.inputRoomname.value = roomFromUrl;

    dom.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const username = dom.inputUsername.value;
      const roomName = dom.inputRoomname.value;
      setText(dom.loginError, '');

      const validation = clientValidateJoinInput(username, roomName);
      if (!validation.ok) {
        setText(dom.loginError, validation.message);
        return;
      }

      rememberUsername(username.trim());
      clientState.socket.emit(EVT.JOIN_ROOM, { username, roomName });
    });
  }

  // ==========================================================================
  // بخش ۲۰: اتصال دکمه‌های لابی
  // ==========================================================================

  /** تمام دکمه‌ها و ورودی‌های ویوی لابی (آماده/کپی‌لینک/تنظیمات نقش/شروع بازی) را به eventهای متناظر وصل می‌کند. */
  function wireLobbyControls() {
    dom.btnToggleReady.addEventListener('click', () => {
      clientState.socket.emit(EVT.TOGGLE_READY);
    });

    dom.btnLeaveLobby.addEventListener('click', () => leaveRoomAndReturnToLogin());

    dom.btnCopyRoom.addEventListener('click', async () => {
      const roomName = clientState.room ? clientState.room.id : '';
      const inviteLink = buildInviteLink(roomName);
      try {
        await navigator.clipboard.writeText(inviteLink);
        toast('لینک دعوت کپی شد.', 'success');
      } catch (err) {
        toast(`لینک دعوت: ${inviteLink}`, 'info');
      }
    });

    const debouncedUpdateTotal = debounce(updateRolesConfigTotal, 150);
    [
      dom.roleCountMafiaBoss,
      dom.roleCountMafia,
      dom.roleCountDoctorLecter,
      dom.roleCountDoctor,
      dom.roleCountDetective,
      dom.roleCountSaqi,
      dom.roleCountNatasha,
      dom.roleCountSniper,
      dom.roleCountCitizen,
    ].forEach((input) => {
      input.addEventListener('input', debouncedUpdateTotal);
    });

    dom.btnAutoRoles.addEventListener('click', () => applyAutoRolesConfig());

    dom.btnSaveRoles.addEventListener('click', () => {
      const rolesConfig = readRolesConfigFromInputs();
      clientState.socket.emit(EVT.UPDATE_ROOM_SETTINGS, { rolesConfig });
      toast('تنظیمات نقش‌ها ذخیره شد.', 'success');
    });

    dom.btnStartGame.addEventListener('click', () => {
      setText(dom.lobbyStartError, '');
      guardedEmit(dom.btnStartGame, EVT.START_GAME);
    });
  }

  // ==========================================================================
  // بخش ۲۱: اتصال دکمه‌های فاز بازی
  // ==========================================================================

  /** دکمه‌های داخل فاز بازی (تأیید نقش، پایان زودهنگام شب/رأی‌گیری، دور جدید، خروج) را وصل می‌کند. */
  function wireGameControls() {
    dom.btnAckRole.addEventListener('click', () => {
      clientState.socket.emit(EVT.ACKNOWLEDGE_ROLE);
      hideRoleRevealModal();
    });

    dom.btnForceResolveNight.addEventListener('click', () => {
      guardedEmit(dom.btnForceResolveNight, EVT.FORCE_RESOLVE_NIGHT);
    });

    dom.btnAdvanceVoting.addEventListener('click', () => {
      guardedEmit(dom.btnAdvanceVoting, EVT.ADVANCE_TO_VOTING);
    });

    dom.btnEndVoting.addEventListener('click', () => {
      guardedEmit(dom.btnEndVoting, EVT.END_VOTING);
    });

    dom.btnEndDefense.addEventListener('click', () => {
      guardedEmit(dom.btnEndDefense, EVT.END_DEFENSE);
    });

    dom.btnPlayAgain.addEventListener('click', () => {
      guardedEmit(dom.btnPlayAgain, EVT.PLAY_AGAIN);
    });

    dom.btnLeaveAfterGame.addEventListener('click', () => leaveRoomAndReturnToLogin());
  }

  /**
   * پیش از خروج از اتاق تأییدیه می‌گیرد؛ چون خروج در حین بازی برگشت‌ناپذیر
   * است (سرور بازیکن را به‌عنوان disconnected علامت می‌زند و صندلی او دیگر
   * در همان دور فعال نمی‌شود). در فاز لابی، تأییدیه لازم نیست چون هزینه‌ای ندارد.
   */
  function leaveRoomAndReturnToLogin() {
    const inActiveGame =
      clientState.room && clientState.room.phase && clientState.room.phase !== PHASES.LOBBY;
    if (inActiveGame) {
      const sure = window.confirm('بازی در حال اجراست. مطمئنید می‌خواهید از اتاق خارج شوید؟');
      if (!sure) return;
    }

    leaveVoice();
    clientState.socket.emit(EVT.LEAVE_ROOM);
    clientState.room = null;
    clientState.you = null;
    clientState.myRole = null;
    hideRoleRevealModal();
    hideGameOverModal();
    showView('login');
  }

  // ==========================================================================
  // بخش ۲۲: WebRTC - ویس زنده‌ی گروهی (mesh)
  // ==========================================================================

  /**
   * لیست میکروفون‌های موجود را می‌خواند و در dom.micDeviceSelect پر می‌کند.
   * برچسب دستگاه‌ها (device.label) معمولاً فقط بعد از گرفتن مجوز میکروفون
   * در دسترس است؛ به همین دلیل این تابع هم قبل و هم بعد از joinVoice فراخوانی می‌شود.
   */
  async function populateMicDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      clearChildren(dom.micDeviceSelect);
      mics.forEach((mic, idx) => {
        const opt = document.createElement('option');
        opt.value = mic.deviceId;
        opt.textContent = mic.label || `میکروفون ${idx + 1}`;
        dom.micDeviceSelect.appendChild(opt);
      });
      if (mics.length > 1) show(dom.micDeviceSelect);
    } catch (err) {
      console.warn('عدم امکان خواندن لیست میکروفون‌ها:', err);
    }
  }

  /**
   * وارد ویس اتاق می‌شود: مجوز میکروفون می‌گیرد، رویداد voice_join را
   * می‌فرستد، و برای هر peerی که از قبل در ویس است (طبق آخرین room_state)
   * یک offer WebRTC می‌سازد. طبق پروتکل mesh این پروژه، تازه‌واردها همیشه
   * offer را آغاز می‌کنند؛ اعضای موجود صرفاً منتظر offer می‌مانند (نگاه کنید
   * به handler رویداد VOICE_OFFER در initSocket) تا از glare (هر دو طرف
   * هم‌زمان offer بفرستند) جلوگیری شود.
   */
  async function joinVoice() {
    if (clientState.inVoice) return;
    hide(dom.voicePermissionError);

    try {
      const deviceId = dom.micDeviceSelect && dom.micDeviceSelect.value;
      const constraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      clientState.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error('خطا در دسترسی به میکروفون:', err);
      show(dom.voicePermissionError);
      setText(
        dom.voicePermissionError,
        'دسترسی به میکروفون رد شد یا در دسترس نیست. لطفاً مجوز مرورگر را بررسی کنید.'
      );
      toast('دسترسی به میکروفون ممکن نشد.', 'error');
      return;
    }

    clientState.inVoice = true;
    updateVoiceUi();
    populateMicDevices();
    startSpeakingDetection();

    // به تمام peerهایی که از قبل در ویس هستند، آفر می‌فرستیم.
    const myId = clientState.you && clientState.you.id;
    const existingVoicePeers = clientState.room
      ? clientState.room.players.filter((p) => p.inVoice && p.id !== myId && p.connected)
      : [];

    clientState.socket.emit(EVT.VOICE_JOIN);

    for (const peer of existingVoicePeers) {
      await createOfferTo(peer.id);
    }
  }

  /** از ویس خارج می‌شود: تمام peer connectionها را می‌بندد، track های محلی را متوقف می‌کند و به سرور اطلاع می‌دهد. */
  function leaveVoice() {
    if (!clientState.inVoice) {
      // حتی اگر در ویس نبودیم، مطمئن شویم منابع آزاد است.
      return;
    }
    clientState.inVoice = false;

    if (clientState.localStream) {
      clientState.localStream.getTracks().forEach((t) => t.stop());
      clientState.localStream = null;
    }

    Array.from(clientState.peers.keys()).forEach((peerId) => cleanupPeer(peerId));
    stopSpeakingDetection();

    clientState.socket.emit(EVT.VOICE_LEAVE);
    updateVoiceUi();
  }

  /** میکروفون محلی را قطع/وصل می‌کند (با غیرفعال‌کردن track، نه بستن اتصال) و وضعیت را به بقیه‌ی اتاق اطلاع می‌دهد. */
  function toggleMic() {
    if (!clientState.localStream) return;
    if (clientState.forcedMuted) return; // در دفاعیه (غیر متهم) یا سایلنتِ ناتاشا، کاربر نمی‌تواند خودش را unmute کند
    clientState.isMuted = !clientState.isMuted;
    clientState.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !clientState.isMuted;
    });
    clientState.socket.emit(EVT.VOICE_TOGGLE_MUTE, { isMuted: clientState.isMuted });
    updateVoiceUi();
  }

  /**
   * میکروفون را به‌زور قطع (یا آزاد) می‌کند - برای دفاعیه (غیر متهم) و
   * سایلنتِ ناتاشا. وقتی forced=true است، دکمه‌ی میکروفون غیرفعال می‌شود تا
   * کاربر نتواند خودش را unmute کند.
   */
  function applyForcedMute(forced) {
    clientState.forcedMuted = forced;
    if (forced) {
      clientState.isMuted = true;
      if (clientState.localStream) {
        clientState.localStream.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
      }
      clientState.socket.emit(EVT.VOICE_TOGGLE_MUTE, { isMuted: true });
    }
    updateVoiceUi();
  }

  /** میکروفون را به‌زور آزاد و روشن می‌کند - فقط برای متهم در فاز دفاعیه. */
  function forceUnmuteSelf() {
    clientState.forcedMuted = false;
    clientState.isMuted = false;
    if (clientState.localStream) {
      clientState.localStream.getAudioTracks().forEach((t) => {
        t.enabled = true;
      });
    }
    clientState.socket.emit(EVT.VOICE_TOGGLE_MUTE, { isMuted: false });
    updateVoiceUi();
  }

  /**
   * بر اساس فاز جاری، تصمیم می‌گیرد که آیا میکروفون این کلاینت باید به‌زور
   * قطع باشد یا نه: در فاز شب اگر عضو تیم مافیا نباشید (فقط مافیا شب صحبت
   * می‌کند)، در فاز دفاعیه اگر متهم نباشید (defense_started جداگانه متهم را
   * آزاد می‌کند)، و در فاز روز اگر سایلنتِ ناتاشا باشید.
   */
  function updateForcedMuteForPhase(phase) {
    const me = getMe();
    if (!me) {
      applyForcedMute(false);
      return;
    }
    if (phase === PHASES.NIGHT) {
      const role = clientState.myRole ? clientState.myRole.role : me.role;
      const isMafiaTeam = role === 'mafia_boss' || role === 'mafia' || role === 'doctor_lecter';
      applyForcedMute(!isMafiaTeam);
      if (isMafiaTeam) applyNightVoiceRoutingAll();
    } else if (phase === PHASES.DEFENSE) {
      applyForcedMute(true); // defense_started بلافاصله بعد، فقط متهم را آزاد می‌کند
    } else if (phase === PHASES.DAY) {
      restoreDayVoiceRoutingAll();
      const iAmSilenced = clientState.room && clientState.room.silencedPlayerId === me.id;
      applyForcedMute(iAmSilenced);
    } else {
      restoreDayVoiceRoutingAll();
      applyForcedMute(false);
    }
  }

  /** آیا id مشخص‌شده جزو هم‌تیمی‌های زنده‌ی مافیا (یا خودم) است؟ برای تصمیم‌گیری routing شب. */
  function isMafiaTeammateOrSelf(peerId) {
    if (clientState.you && peerId === clientState.you.id) return true;
    return (clientState.mafiaTeammates || []).some((t) => t.id === peerId);
  }

  /** اگر خودم عضو تیم مافیا هستم، صدای این peer خاص را طبق قانون شب (فقط برای هم‌تیمی‌ها) تنظیم می‌کند. */
  function applyNightVoiceRoutingToPeer(peerId) {
    const me = getMe();
    if (!me) return;
    const role = clientState.myRole ? clientState.myRole.role : me.role;
    const isMafiaTeam = role === 'mafia_boss' || role === 'mafia' || role === 'doctor_lecter';
    if (!isMafiaTeam) return; // برای غیرمافیا این تابع کاری نمی‌کند؛ سکوتشان با forced-mute تضمین می‌شود

    const sender = clientState.senders.get(peerId);
    if (!sender || !clientState.localStream) return;
    const realTrack = clientState.localStream.getAudioTracks()[0] || null;

    if (isMafiaTeammateOrSelf(peerId)) {
      sender.replaceTrack(realTrack).catch(() => {});
    } else {
      sender.replaceTrack(null).catch(() => {});
    }
  }

  /** قانون routing شب را روی تمام peer connectionهای فعلی اعمال می‌کند (وقتی شب شروع می‌شود یا روستر تیم می‌رسد). */
  function applyNightVoiceRoutingAll() {
    for (const peerId of clientState.peers.keys()) {
      applyNightVoiceRoutingToPeer(peerId);
    }
  }

  /** با پایان شب، صدای همه‌ی peerها دوباره به‌صورت عادی جاری می‌شود. */
  function restoreDayVoiceRoutingAll() {
    if (!clientState.localStream) return;
    const realTrack = clientState.localStream.getAudioTracks()[0] || null;
    for (const sender of clientState.senders.values()) {
      sender.replaceTrack(realTrack).catch(() => {});
    }
  }

  /** دکمه‌ها و متن وضعیت ویس را (هم در لابی هم در بازی) با clientState.inVoice/isMuted هماهنگ می‌کند. */
  function updateVoiceUi() {
    const pairs = [
      [dom.btnVoiceJoin, dom.btnVoiceLeave, dom.btnMicToggle, dom.voiceStatus],
      [dom.btnVoiceJoinIngame, dom.btnVoiceLeaveIngame, dom.btnMicToggleIngame, dom.voiceStatusIngame],
    ];
    pairs.forEach(([joinBtn, leaveBtn, micBtn, statusEl]) => {
      if (!joinBtn) return;
      if (clientState.inVoice) {
        hide(joinBtn);
        show(leaveBtn);
        show(micBtn);
        micBtn.disabled = clientState.forcedMuted;
        micBtn.textContent = clientState.isMuted ? '🔇' : '🎤';
        setText(
          statusEl,
          clientState.forcedMuted
            ? 'میکروفون شما موقتاً قفل است'
            : clientState.isMuted
            ? 'ویس فعال (میکروفون قطع)'
            : 'ویس فعال'
        );
      } else {
        show(joinBtn);
        hide(leaveBtn);
        hide(micBtn);
        setText(statusEl, 'ویس غیرفعال');
      }
    });
  }

  /**
   * اتصال WebRTC موجود برای peerId را برمی‌گرداند یا در صورت نبود، یکی
   * می‌سازد: track های محلی را اضافه می‌کند و handlerهای icecandidate/track
   * را وصل می‌کند. این تابع idempotent است - صدا زدن دوباره برای همان peer
   * اتصال جدید نمی‌سازد.
   */
  function getOrCreatePeerConnection(peerId) {
    let pc = clientState.peers.get(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    clientState.peers.set(peerId, pc);

    if (clientState.localStream) {
      clientState.localStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, clientState.localStream);
        clientState.senders.set(peerId, sender);
      });
      // اگر همین الان شبی در جریان است و من مافیا هستم، قانون routing شب را فوراً روی این اتصال تازه اعمال کن.
      applyNightVoiceRoutingToPeer(peerId);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        clientState.socket.emit(EVT.VOICE_ICE_CANDIDATE, {
          targetId: peerId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      attachRemoteAudio(peerId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // اتصال ممکن است بعداً با ICE restart بازیابی شود؛ فعلاً صرفاً لاگ می‌کنیم.
        console.warn(`اتصال ویس با ${peerId} در وضعیت ${pc.connectionState} است.`);
      }
    };

    return pc;
  }

  /** یک offer WebRTC به peerId مشخص می‌سازد و از طریق سرور (signaling) برایش می‌فرستد. */
  async function createOfferTo(peerId) {
    const pc = getOrCreatePeerConnection(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    clientState.socket.emit(EVT.VOICE_OFFER, { targetId: peerId, sdp: pc.localDescription });
  }

  /** استریم صوتی دریافتی از یک peer را به یک عنصر <audio> جدید یا موجود متصل می‌کند تا پخش شود. */
  function attachRemoteAudio(peerId, stream) {
    let audioEl = clientState.audioEls.get(peerId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.dataset.peerId = peerId;
      dom.audioContainer.appendChild(audioEl);
      clientState.audioEls.set(peerId, audioEl);
    }
    audioEl.srcObject = stream;
  }

  /** یک peer connection و عنصر audio متناظرش را کاملاً پاک می‌کند (هنگام voice_peer_left یا leaveVoice). */
  function cleanupPeer(peerId) {
    const pc = clientState.peers.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
      clientState.peers.delete(peerId);
    }
    clientState.senders.delete(peerId);
    const audioEl = clientState.audioEls.get(peerId);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      clientState.audioEls.delete(peerId);
    }
    updateSpeakingIndicator(peerId, false);
  }

  // ---------------- تشخیص «در حال صحبت» با Web Audio API ----------------

  /**
   * با Web Audio API (AnalyserNode) میانگین حجم صدای میکروفون محلی را در هر
   * فریم می‌سنجد و فقط هنگام تغییر وضعیت (سکوت <-> صحبت) رویداد voice_speaking
   * را (throttle شده) به سرور می‌فرستد تا ترافیک سوکت زیاد نشود. نتیجه هم به‌صورت
   * optimistic روی کارت خودِ بازیکن اعمال می‌شود.
   */
  function startSpeakingDetection() {
    if (!clientState.localStream) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      clientState.audioContext = new AudioCtx();
      const source = clientState.audioContext.createMediaStreamSource(clientState.localStream);
      clientState.analyser = clientState.audioContext.createAnalyser();
      clientState.analyser.fftSize = 512;
      source.connect(clientState.analyser);

      const buffer = new Uint8Array(clientState.analyser.frequencyBinCount);
      const sendSpeaking = throttle((isSpeaking) => {
        clientState.socket.emit(EVT.VOICE_SPEAKING, { isSpeaking });
      }, 250);

      const loop = () => {
        if (!clientState.analyser) return;
        clientState.analyser.getByteFrequencyData(buffer);
        const avg = buffer.reduce((a, b) => a + b, 0) / buffer.length / 255;
        const isSpeaking = avg > SPEAKING_THRESHOLD && !clientState.isMuted;

        if (isSpeaking !== clientState.lastSpeakingValue) {
          clientState.lastSpeakingValue = isSpeaking;
          sendSpeaking(isSpeaking);
          updateSpeakingIndicator(clientState.you ? clientState.you.id : 'me', isSpeaking);
        }
        clientState.speakingLoopHandle = requestAnimationFrame(loop);
      };
      loop();
    } catch (err) {
      console.warn('تشخیص صحبت‌کردن با خطا مواجه شد:', err);
    }
  }

  /** حلقه‌ی تشخیص صحبت و AudioContext را متوقف/آزاد می‌کند (هنگام leaveVoice). */
  function stopSpeakingDetection() {
    if (clientState.speakingLoopHandle) {
      cancelAnimationFrame(clientState.speakingLoopHandle);
      clientState.speakingLoopHandle = null;
    }
    if (clientState.audioContext) {
      clientState.audioContext.close().catch(() => {});
      clientState.audioContext = null;
      clientState.analyser = null;
    }
    clientState.lastSpeakingValue = false;
    if (clientState.you) updateSpeakingIndicator(clientState.you.id, false);
  }

  /** دکمه‌های ویس را (نسخه‌ی لابی و نسخه‌ی درون‌بازی، هر دو) به توابع مشترک joinVoice/leaveVoice/toggleMic وصل می‌کند. */
  function wireVoiceControls() {
    [dom.btnVoiceJoin, dom.btnVoiceJoinIngame].forEach((btn) =>
      btn.addEventListener('click', () => joinVoice())
    );
    [dom.btnVoiceLeave, dom.btnVoiceLeaveIngame].forEach((btn) =>
      btn.addEventListener('click', () => leaveVoice())
    );
    [dom.btnMicToggle, dom.btnMicToggleIngame].forEach((btn) =>
      btn.addEventListener('click', () => toggleMic())
    );
    if (dom.micDeviceSelect) {
      dom.micDeviceSelect.addEventListener('change', () => {
        if (clientState.inVoice) {
          // برای اعمال میکروفون جدید، ویس را ری‌استارت می‌کنیم.
          leaveVoice();
          setTimeout(() => joinVoice(), 300);
        }
      });
    }
  }

  // ==========================================================================
  // بخش ۲۵: اعلان روی عنوان تب مرورگر (Title Alert)
  // ==========================================================================
  //
  // وقتی نوبت اکشنی از کاربر است (اکشن شب یا رأی‌گیری) و تب در پس‌زمینه است
  // (کاربر روی تب دیگری است)، عنوان تب چشمک می‌زند تا کاربر متوجه شود. به
  // محض بازگشت به تب (visibilitychange)، چشمک‌زدن متوقف و عنوان اصلی برمی‌گردد.
  // این ویژگی کاملاً کلاینت-محور است و به هیچ eventی از سرور نیاز ندارد.

  const ORIGINAL_TITLE = document.title;
  let titleFlashHandle = null;
  let titleFlashOn = false;

  /** چشمک‌زدن عنوان تب را با متن alertText شروع می‌کند (فقط اگر تب همین الان در پس‌زمینه باشد). */
  function startTitleAlert(alertText) {
    if (!document.hidden) return; // اگر کاربر همین الان تب را می‌بیند، نیازی به اعلان نیست
    stopTitleAlert();
    titleFlashHandle = setInterval(() => {
      document.title = titleFlashOn ? ORIGINAL_TITLE : alertText;
      titleFlashOn = !titleFlashOn;
    }, 1200);
  }

  /** چشمک‌زدن عنوان تب را متوقف و عنوان اصلی صفحه را برمی‌گرداند. */
  function stopTitleAlert() {
    if (titleFlashHandle) {
      clearInterval(titleFlashHandle);
      titleFlashHandle = null;
    }
    titleFlashOn = false;
    document.title = ORIGINAL_TITLE;
  }

  /** هر بار تب دوباره قابل‌مشاهده شد (کاربر برگشت)، اعلان را متوقف می‌کند. */
  function wireVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) stopTitleAlert();
    });
  }

  /**
   * بر اساس فاز جاری و نقش/وضعیت خودِ بازیکن تشخیص می‌دهد که آیا الان
   * «نوبت اوست» یا نه، و در صورت لزوم اعلان عنوان تب را فعال می‌کند.
   * این تابع بعد از هر applyPhaseChange فراخوانی می‌شود.
   */
  function maybeAlertForMyTurn(phase) {
    const me = getMe();
    if (!me || !me.isAlive) return;

    if (phase === PHASES.NIGHT) {
      const role = clientState.myRole ? clientState.myRole.role : me.role;
      if (role === 'mafia' || role === 'doctor' || role === 'detective') {
        startTitleAlert('🌙 نوبت اکشن شماست!');
      }
    } else if (phase === PHASES.VOTING) {
      startTitleAlert('🗳️ نوبت رأی شماست!');
    }
  }

  // ==========================================================================
  // بخش ۲۶: خروج تمیز هنگام بستن تب
  // ==========================================================================

  /** هنگام بستن/رفرش تب، به سرور اطلاع می‌دهد که بازیکن اتاق را ترک کرده (best-effort، بدون انتظار پاسخ). */
  function wireUnloadHandlers() {
    window.addEventListener('beforeunload', () => {
      if (clientState.socket) {
        clientState.socket.emit(EVT.LEAVE_ROOM);
      }
    });
  }

  // ==========================================================================
  // بخش ۲۴: راه‌اندازی اولیه (Bootstrap)
  // ==========================================================================

  /**
   * نقطه‌ی ورود برنامه. ترتیب فراخوانی مهم است: ابتدا DOM کش می‌شود (cacheDom)
   * تا بقیه‌ی توابع بتوانند با خیال راحت از dom.* استفاده کنند، سپس اتصال
   * سوکت و تمام wireهای رویداد برقرار می‌شوند.
   */
  function init() {
    cacheDom();
    wireGlobalErrorHandlers();
    showView('login');
    setConnectionState('connecting', 'در حال اتصال به سرور...');

    initSocket();
    wireLoginForm();
    wireLobbyControls();
    wireGameControls();
    wireVoiceControls();
    wireUnloadHandlers();
    wireVisibilityHandler();

    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      populateMicDevices();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // برای دیباگ دستی در کنسول مرورگر (اختیاری، بدون اثر جانبی روی منطق بازی)
  window.__mafiaDebug = { clientState, dom };
})();
