'use strict';

/* Lazarus v6.0 — content script
 *
 * Capture is fully delegated: one capture-phase input listener on the document,
 * so dynamic forms work without per-node bookkeeping or a document-wide
 * MutationObserver. Restores validate the page URL and report success.
 */

(function () {
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime) return;
  if (window.__lazarusInstalled) return;
  window.__lazarusInstalled = true;

  const SEARCH_ENGINES = [
    'google.com', 'www.google.com', 'google.co.uk', 'google.de', 'google.fr',
    'bing.com', 'www.bing.com', 'yahoo.com', 'www.yahoo.com',
    'duckduckgo.com', 'www.duckduckgo.com', 'baidu.com', 'www.baidu.com',
    'yandex.com', 'www.yandex.com', 'ask.com', 'www.ask.com'
  ];

  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'url', 'tel', 'number', 'password'
  ]);

  const SENSITIVE_NAMES = new Set([
    'cvv', 'cvc', 'csc', 'ccv', 'cardnumber', 'creditcard', 'ccnum', 'ssn', 'pin',
    'pincode', 'passcode', 'expiry', 'cryptoseed', 'seedphrase', 'mnemonic', 'seed',
    'passphrase', 'bip39', 'otp', 'totp', 'verificationcode', 'authcode', 'securitycode'
  ]);

  const SENSITIVE_JOINED = [
    'cardnumber', 'creditcardnumber', 'ccnumber', 'ccnum', 'securitycode',
    'verificationcode', 'authcode', 'onetimecode', 'onetimepassword',
    'cryptoseed', 'seedphrase', 'recoveryphrase', 'mnemonic', 'bip39', 'passphrase'
  ];

  /* Match whole name/id tokens instead of substrings: `shipping` contains
   * "pin", and treating it as a PIN field silently stopped Lazarus recording
   * on countless address forms. */
  function nameLooksSensitive(el) {
    const raw = String(el.name || '') + ' ' + String(el.id || '');
    const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    const tokens = spaced.split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.some(t => SENSITIVE_NAMES.has(t))) return true;
    if (tokens.some(t => /^(cvv|cvc|csc|ccv|otp|totp)\d*$/.test(t))) return true;
    const joined = tokens.join('');
    return SENSITIVE_JOINED.some(part => joined.includes(part));
  }

  const SECRET_PATTERNS = [
    /sk_live_[0-9a-zA-Z]{24,99}/,
    /eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/,
    /-----BEGIN[\s\S]+?END .+ KEY-----/,
    /ghp_[A-Za-z0-9]{36}/,
    /xox[bprs]-[A-Za-z0-9-]+/,
    /AIza[0-9A-Za-z\-_]{35}/
  ];

  const BIP39 = new Set(('abandon ability able about above absent absorb abstract absurd accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid africa after again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tolerate tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo').split(' '));

  const state = {
    settings: {
      savePasswords: false,
      retentionHours: 720,
      searchIndexing: true,
      paletteEnabled: true,
      autoLockMinutes: 15
    },
    blacklisted: false,
    locked: false,
    lastField: null,
    panelOpen: false
  };

  const saveTimers = new WeakMap();
  const isSearchEngine = SEARCH_ENGINES.includes(location.hostname);

  /* ---------------------------------------------------------------- */
  /* helpers                                                          */
  /* ---------------------------------------------------------------- */

  if (!window.CSS || !window.CSS.escape) {
    window.CSS = window.CSS || {};
    window.CSS.escape = function (value) { return String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, '\\$&'); };
  }

  function send(type, data) {
    return api.runtime.sendMessage({ type, ...(data || {}) }).catch(() => null);
  }

  function messageNode(className, text) {
    const node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    return node;
  }

  function normalizeUrl(input) {
    try {
      const u = new URL(input);
      for (const p of Array.from(u.searchParams.keys())) {
        if (/^(utm_|fbclid$|gclid$|mc_|igshid$|si$|ref$|ref_src$|source$|spm$)/i.test(p)) {
          u.searchParams.delete(p);
        }
      }
      u.hash = '';
      return u.toString();
    } catch { return null; }
  }

  function timeAgo(ms) {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 45) return 'now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + 'h';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      return TEXT_INPUT_TYPES.has(type);
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
    return false;
  }

  function isSensitive(el) {
    if (state.blacklisted) return true;
    const type = (el.type || '').toLowerCase();
    if (type === 'hidden') return true;
    if (type === 'password' && !state.settings.savePasswords) return true;

    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('cc-') || autocomplete === 'one-time-code') return true;

    if (nameLooksSensitive(el)) return true;

    const form = el.closest && el.closest('form');
    if (form) {
      const action = (form.getAttribute('action') || '').toLowerCase();
      if (/paypal|stripe|checkout|payment/.test(action) && /number|cvv|exp|card/.test(name)) return true;
    }

    const value = readValue(el).trim();
    if (value && value.length <= 500) {
      const words = value.split(/\s+/);
      if ([12, 15, 18, 21, 24].includes(words.length) && words.every(w => BIP39.has(w.toLowerCase()))) {
        return true;
      }
      if (value.length < 200 && SECRET_PATTERNS.some(r => r.test(value))) return true;
    }
    return false;
  }

  function readValue(el) {
    if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      return el.textContent || '';
    }
    return el.value || '';
  }

  function writeValue(el, text) {
    if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      el.textContent = text;
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
  }

  function fieldSelector(el) {
    if (el.name) {
      let selector = el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
      if (el.tagName === 'INPUT' && el.type) selector += '[type="' + CSS.escape(el.type.toLowerCase()) + '"]';
      return selector;
    }
    if (el.id) return '#' + CSS.escape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      if (node.id) { path.unshift('#' + CSS.escape(node.id)); break; }
      let nth = 1;
      let sibling = node;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.nodeName === node.nodeName) nth++;
      }
      let part = node.nodeName.toLowerCase() + ':nth-of-type(' + nth + ')';
      if (node.name) part += '[name="' + CSS.escape(node.name) + '"]';
      path.unshift(part);
      node = node.parentNode;
    }
    return path.join(' > ');
  }

  function fieldCandidates(el) {
    const list = [];
    const push = value => { if (value && !list.includes(value)) list.push(value); };
    push(fieldSelector(el));
    if (el.name) push('[name="' + CSS.escape(el.name) + '"]');
    if (el.id) push('#' + CSS.escape(el.id));
    return list;
  }

  function queryDeep(selector) {
    try {
      const direct = document.querySelector(selector);
      if (direct) return direct;
    } catch { return null; }

    const walk = root => {
      let found = null;
      const nodes = root.querySelectorAll('*');
      for (const node of nodes) {
        if (!node.shadowRoot) continue;
        try {
          found = node.shadowRoot.querySelector(selector);
        } catch { /* invalid selector in this root */ }
        if (found) return found;
        found = walk(node.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    return walk(document);
  }

  function findField(selector) {
    let el = queryDeep(selector);
    if (el) return el;
    const nameMatch = selector.match(/\[name="([^"]+)"\]/);
    if (nameMatch) {
      el = queryDeep('[name="' + nameMatch[1].replace(/"/g, '\\"') + '"]');
      if (el) return el;
    }
    const idMatch = selector.match(/#([^\s>]+)/);
    if (idMatch) {
      el = queryDeep('#' + idMatch[1]);
      if (el) return el;
    }
    return null;
  }

  function restoreInto(el, text) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
      writeValue(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flash(el, 'lz-flash');
      setTimeout(() => el.dispatchEvent(new Event('blur', { bubbles: true })), 40);
      return true;
    } catch {
      return false;
    }
  }

  function restoreWhenReady(selector, text, timeout) {
    return new Promise(resolve => {
      const immediate = findField(selector);
      if (immediate) { resolve(restoreInto(immediate, text)); return; }

      const deadline = Date.now() + (timeout || 2500);
      const observer = new MutationObserver(() => {
        const el = findField(selector);
        if (el) {
          observer.disconnect();
          resolve(restoreInto(el, text));
        } else if (Date.now() > deadline) {
          observer.disconnect();
          resolve(false);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        const late = findField(selector);
        resolve(late ? restoreInto(late, text) : false);
      }, timeout || 2500);
    });
  }

  /* ---------------------------------------------------------------- */
  /* capture                                                          */
  /* ---------------------------------------------------------------- */

  function canCapture(el) {
    if (state.blacklisted) return false;
    if (isSearchEngine) return false;
    if (!isEditable(el)) return false;
    if (isSensitive(el)) return false;
    return true;
  }

  async function flushSave(el) {
    saveTimers.delete(el);
    if (!el.isConnected || !canCapture(el)) return;
    const text = readValue(el).trim();
    if (!text) return;
    const field = fieldSelector(el);
    const response = await send('lz:save', {
      url: location.href,
      field,
      text,
      ts: Date.now()
    });
    if (response && response.ok && !response.unchanged) flash(el, 'lz-saved');
  }

  function scheduleSave(el) {
    const timer = saveTimers.get(el);
    if (timer) clearTimeout(timer);
    saveTimers.set(el, setTimeout(() => flushSave(el), 600));
  }

  document.addEventListener('input', event => {
    const el = event.composedPath ? event.composedPath()[0] : event.target;
    if (!isEditable(el)) return;
    if (!canCapture(el)) return;
    scheduleSave(el);
  }, true);

  document.addEventListener('focusin', event => {
    const el = event.composedPath ? event.composedPath()[0] : event.target;
    if (!isEditable(el)) return;
    state.lastField = el;
    if (!canCapture(el)) { hidePanel(); hideIcon(); return; }
    showIcon(el);
  }, true);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!state.panelOpen && !iconTouched) hideIcon();
    }, 180);
  }, true);

  /* ---------------------------------------------------------------- */
  /* in-field ankh icon + version panel                               */
  /* ---------------------------------------------------------------- */

  const COARSE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const ICON_SIZE = COARSE ? 34 : 22;

  const iconHost = document.createElement('div');
  iconHost.id = 'lazarus-ankh-host';
  iconHost.style.cssText = 'position:fixed;left:0;top:0;display:none;z-index:2147483647;';
  const iconRoot = iconHost.attachShadow({ mode: 'closed' });
  iconRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .btn {
        width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; box-sizing: border-box;
        display: flex; align-items: center; justify-content: center;
        background: #0A0A0B; border: 1px solid #C1121F; border-radius: 0;
        cursor: pointer; padding: 0; margin: 0; line-height: 0;
      }
      .btn:hover { background: #1A1A1D; }
      .btn:focus-visible { outline: 2px solid #C1121F; outline-offset: 1px; }
      svg { width: 13px; height: 13px; display: block; }
    </style>
    <button class="btn" type="button" aria-label="Lazarus drafts for this field">
      <svg viewBox="0 0 24 24" fill="none" stroke="#EDE7DA" stroke-width="2.1">
        <circle cx="12" cy="6.5" r="4"/><path d="M12 10.5V22"/><path d="M5 14.5h14"/>
      </svg>
    </button>`;
  const iconBtn = iconRoot.querySelector('.btn');

  const panelHost = document.createElement('div');
  panelHost.id = 'lazarus-panel-host';
  panelHost.style.cssText = 'position:fixed;left:0;top:0;display:none;z-index:2147483646;';
  const panelRoot = panelHost.attachShadow({ mode: 'closed' });
  panelRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        width: min(320px, calc(100vw - 8px)); box-sizing: border-box; background: #0A0A0B;
        border: 1px solid #26262B; border-radius: 0;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        color: #EDE7DA; font-size: 12px;
      }
      .head {
        display: flex; align-items: center; gap: 8px;
        height: 28px; padding: 0 9px; border-bottom: 1px solid #26262B;
      }
      .field {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: #B9B2A4;
      }
      .count { font-size: 9px; color: #6E6A61; }
      .list { max-height: 208px; overflow-y: auto; }
      .item {
        display: flex; align-items: center; gap: 8px; height: ${COARSE ? 46 : 34}px; padding: 0 9px;
        border-bottom: 1px solid #1c1c20; cursor: pointer;
      }
      .item:last-child { border-bottom: 0; }
      .item:hover { background: #15151A; }
      .text {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: ${COARSE ? 13 : 11}px; color: #EDE7DA;
      }
      .time { font-size: ${COARSE ? 11 : 9}px; color: #8A8578; }
      .kill {
        background: none; border: 0; color: #6E6A61; cursor: pointer;
        padding: ${COARSE ? '12px 8px' : '0 2px'};
        font-family: inherit; font-size: ${COARSE ? 15 : 10}px; line-height: 1;
      }
      .kill:hover { color: #E1192A; }
      .empty, .locked { padding: 12px 10px; font-size: 10px; letter-spacing: .1em; color: #8A8578; text-transform: uppercase; }
      .locked { color: #C1121F; }
      .foot {
        height: 22px; display: flex; align-items: center; padding: 0 9px;
        border-top: 1px solid #26262B; font-size: 8.5px; letter-spacing: .12em;
        color: #6E6A61; text-transform: uppercase;
      }
    </style>
    <div class="panel">
      <div class="head"><span class="field"></span><span class="count"></span></div>
      <div class="list"></div>
      <div class="foot">click to resurrect</div>
    </div>`;
  const panel = panelRoot.querySelector('.panel');
  const panelField = panelRoot.querySelector('.field');
  const panelCount = panelRoot.querySelector('.count');
  const panelList = panelRoot.querySelector('.list');
  const panelFoot = panelRoot.querySelector('.foot');

  let iconTouched = false;
  let activeField = null;

  function positionIcon(el) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) { hideIcon(); return; }
    const x = Math.min(Math.max(rect.right - ICON_SIZE - 2, 2), window.innerWidth - ICON_SIZE - 2);
    const y = Math.min(Math.max(rect.top + (rect.height - ICON_SIZE) / 2, 2), window.innerHeight - ICON_SIZE - 2);
    iconHost.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    iconHost.style.display = 'block';
  }

  function showIcon(el) {
    activeField = el;
    iconHost.style.display = 'block';
    positionIcon(el);
  }

  function hideIcon() {
    if (state.panelOpen) return;
    iconHost.style.display = 'none';
  }

  function hidePanel() {
    panelHost.style.display = 'none';
    state.panelOpen = false;
  }

  function placePanel() {
    if (!activeField || !activeField.isConnected) return;
    const rect = activeField.getBoundingClientRect();
    const height = Math.min(panelList.scrollHeight + 50, 260);
    const below = window.innerHeight - rect.bottom;
    const top = below > height + 8 || rect.top < height + 8
      ? rect.bottom + 4
      : rect.top - height - 4;
    const panelWidth = panel.offsetWidth || 320;
    const left = Math.min(Math.max(rect.left, 4), Math.max(window.innerWidth - panelWidth - 4, 4));
    panelHost.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(Math.max(top, 4)) + 'px)';
  }

  async function openPanel(field) {
    state.panelOpen = true;
    panelHost.style.display = 'block';
    panelField.textContent = field.name || field.id || 'field';
    panelCount.textContent = '';
    panelList.innerHTML = '<div class="empty">reading…</div>';
    placePanel();

    const response = await send('lz:field', {
      url: location.href,
      fields: fieldCandidates(field)
    });

    if (!state.panelOpen) return;

    if (!response || !response.ok) {
      const locked = response && response.error === 'LOCKED';
      panelList.textContent = '';
      panelList.appendChild(messageNode(
        locked ? 'locked' : 'empty',
        locked ? 'vault sealed — open lazarus' : 'no drafts for this field'
      ));
      placePanel();
      return;
    }

    const versions = response.entry.versions.slice().reverse();
    panelCount.textContent = versions.length + ' saved';
    panelList.innerHTML = '';

    versions.forEach(version => {
      const row = document.createElement('div');
      row.className = 'item';

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = version.text.replace(/\s+/g, ' ').slice(0, 70);

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = timeAgo(version.ts);

      const kill = document.createElement('button');
      kill.className = 'kill';
      kill.type = 'button';
      kill.textContent = '✕';
      kill.setAttribute('aria-label', 'Forget this draft');
      kill.addEventListener('click', async event => {
        event.stopPropagation();
        await send('lz:forget-version', { id: response.entry.id, ts: version.ts });
        openPanel(field);
      });

      row.append(text, time, kill);
      row.addEventListener('click', () => {
        restoreInto(field, version.text);
        hidePanel();
        hideIcon();
        iconTouched = false;
      });
      panelList.appendChild(row);
    });
    placePanel();
  }

  let iconTouchTimer = null;
  function markIconTouched() {
    iconTouched = true;
    clearTimeout(iconTouchTimer);
    iconTouchTimer = setTimeout(() => { iconTouched = false; }, 800);
  }
  iconHost.addEventListener('pointerdown', markIconTouched, true);
  iconHost.addEventListener('touchstart', markIconTouched, { capture: true, passive: true });
  iconBtn.addEventListener('mousedown', event => { event.preventDefault(); iconTouched = true; });
  iconBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    iconTouched = true;
    if (state.panelOpen) { hidePanel(); hideIcon(); iconTouched = false; return; }
    const field = activeField && activeField.isConnected ? activeField : state.lastField;
    if (field && field.isConnected) openPanel(field);
  });

  document.addEventListener('mousedown', event => {
    if (event.target === iconHost || event.target === panelHost) return;
    if (!state.panelOpen) return;
    hidePanel();
    hideIcon();
    iconTouched = false;
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (state.panelOpen) { hidePanel(); hideIcon(); iconTouched = false; }
  }, true);

  let rafPending = false;
  const reposition = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (activeField && activeField.isConnected && iconHost.style.display !== 'none') positionIcon(activeField);
      if (state.panelOpen) placePanel();
    });
  };
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  /* ---------------------------------------------------------------- */
  /* saved / restored feedback                                        */
  /* ---------------------------------------------------------------- */

  function flash(el, className) {
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), 900);
  }

  function injectStyles() {
    if (document.getElementById('lazarus-styles')) return;
    const style = document.createElement('style');
    style.id = 'lazarus-styles';
    style.textContent = `
      .lz-saved { outline: 2px solid rgba(193,18,31,.45) !important; outline-offset: 2px !important; }
      .lz-flash { outline: 2px solid #C1121F !important; outline-offset: 2px !important; }`;
    document.documentElement.appendChild(style);
  }

  /* ---------------------------------------------------------------- */
  /* command palette                                                  */
  /* ---------------------------------------------------------------- */

  let palette = null;

  function buildPalette() {
    if (palette) return palette;

    const host = document.createElement('div');
    host.id = 'lazarus-palette-host';
    host.style.display = 'none';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Lazarus drafts');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .scrim {
          position: fixed; inset: 0; background: rgba(4,4,6,.78);
          display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh;
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        }
        .sheet {
          width: 92%; max-width: 520px; background: #0A0A0B;
          border: 1px solid #26262B; border-radius: 0; overflow: hidden;
        }
        .rail { display: flex; align-items: center; gap: 9px; padding: 0 12px; height: 46px; border-bottom: 1px solid #26262B; }
        .rail::before { content: ""; width: 3px; height: 18px; background: #C1121F; }
        input {
          flex: 1; min-width: 0; background: none; border: 0; outline: none; color: #EDE7DA;
          font-family: inherit; font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
        }
        input::placeholder { color: #6E6A61; }
        .kbd { font-size: 9px; color: #6E6A61; border: 1px solid #26262B; padding: 3px 5px; }
        .list { max-height: 300px; overflow-y: auto; }
        .row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid #1c1c20; cursor: pointer; }
        .row:last-child { border-bottom: 0; }
        .row:hover, .row.sel { background: #15151A; }
        .row.sel { border-left: 2px solid #C1121F; padding-left: 10px; }
        .field { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: #B9B2A4; width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .text { flex: 1; min-width: 0; font-size: 11px; color: #EDE7DA; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .time { font-size: 9px; color: #8A8578; }
        .msg { padding: 22px 12px; text-align: center; font-size: 10px; letter-spacing: .12em; color: #8A8578; text-transform: uppercase; }
        .msg.warn { color: #C1121F; }
      </style>
      <div class="scrim">
        <div class="sheet">
          <div class="rail">
            <input type="text" placeholder="Search this page" aria-label="Search saved drafts on this page">
            <span class="kbd">ESC</span>
          </div>
          <div class="list"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    palette = {
      host,
      input: root.querySelector('input'),
      list: root.querySelector('.list'),
      scrim: root.querySelector('.scrim'),
      rows: [],
      selected: -1,
      visible: false
    };

    palette.input.addEventListener('input', renderPaletteRows);
    palette.host.addEventListener('click', event => {
      if (event.target === palette.host || event.target === palette.scrim) closePalette();
    });
    palette.host.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); commitSelection(); }
    });
    return palette;
  }

  let paletteEntries = [];

  function moveSelection(delta) {
    if (!palette.rows.length) return;
    palette.selected = Math.min(Math.max(palette.selected + delta, 0), palette.rows.length - 1);
    palette.rows.forEach((row, index) => row.classList.toggle('sel', index === palette.selected));
    palette.rows[palette.selected].scrollIntoView({ block: 'nearest' });
  }

  function commitSelection() {
    const row = palette.rows[palette.selected];
    if (row) row.click();
  }

  function renderPaletteRows() {
    if (!palette) return;
    const query = palette.input.value.trim().toLowerCase();
    const matches = paletteEntries.filter(entry => {
      if (!query) return true;
      return entry.field.toLowerCase().includes(query) || (entry.preview || '').toLowerCase().includes(query);
    });

    palette.list.innerHTML = '';
    palette.rows = [];
    palette.selected = -1;

    if (!matches.length) {
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = paletteEntries.length ? 'no matching drafts' : 'nothing saved for this page';
      palette.list.appendChild(msg);
      return;
    }

    matches.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'row';

      const field = document.createElement('span');
      field.className = 'field';
      field.textContent = entry.field;

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = entry.preview || '';

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = timeAgo(entry.ts);

      row.append(field, text, time);
      row.addEventListener('click', async () => {
        const full = await send('lz:entry', { id: entry.id });
        closePalette();
        if (full && full.ok) {
          const last = full.entry.versions[full.entry.versions.length - 1];
          restoreWhenReady(entry.field, last.text, 2500);
        }
      });
      palette.list.appendChild(row);
      palette.rows.push(row);
    });

    if (palette.rows.length) {
      palette.selected = 0;
      palette.rows[0].classList.add('sel');
    }
  }

  async function openPalette() {
    if (state.blacklisted || !state.settings.paletteEnabled) return;
    buildPalette();
    palette.visible = true;
    palette.host.style.display = 'block';
    palette.input.value = '';
    palette.list.innerHTML = '<div class="msg">reading…</div>';
    palette.input.focus();

    const response = await send('lz:list', { url: location.href, all: false });
    if (!palette.visible) return;

    if (!response || !response.ok) {
      const locked = response && response.error === 'LOCKED';
      palette.list.textContent = '';
      palette.list.appendChild(messageNode(
        'msg' + (locked ? ' warn' : ''),
        locked ? 'vault sealed — open lazarus' : 'vault unavailable'
      ));
      return;
    }
    paletteEntries = response.entries;
    renderPaletteRows();
  }

  function closePalette() {
    if (!palette) return;
    palette.visible = false;
    palette.host.style.display = 'none';
    palette.list.innerHTML = '';
    palette.rows = [];
  }

  /* ---------------------------------------------------------------- */
  /* messages from the background / popup                             */
  /* ---------------------------------------------------------------- */

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'lz:restore') {
      const current = normalizeUrl(location.href);
      if (msg.url && current && normalizeUrl(msg.url) !== current) {
        sendResponse({ ok: false, error: 'URL_MISMATCH' });
        return;
      }
      restoreWhenReady(msg.field, msg.text, 2500).then(found => sendResponse({ ok: found }));
      return true;
    }

    if (msg.type === 'lz:restore-all') {
      const current = normalizeUrl(location.href);
      if (msg.url && current && normalizeUrl(msg.url) !== current) {
        sendResponse({ ok: false, error: 'URL_MISMATCH' });
        return;
      }
      const items = Array.isArray(msg.items) ? msg.items : [];
      Promise.all(items.map(item => restoreWhenReady(item.field, item.text, 2500)))
        .then(results => {
          const restored = results.filter(Boolean).length;
          sendResponse({ ok: restored > 0, restored, total: items.length });
        });
      return true;
    }

    if (msg.type === 'lz:get-active-field') {
      const el = state.lastField;
      sendResponse({ ok: true, field: el && el.isConnected ? fieldSelector(el) : null });
      return;
    }

    if (msg.type === 'lz:toggle-palette') {
      (async () => {
        if (palette && palette.visible) closePalette();
        else await openPalette();
        sendResponse({ ok: true });
      })();
      return true;
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['lz.settings']) {
      state.settings = { ...state.settings, ...(changes['lz.settings'].newValue || {}) };
    }
    if (changes['lz.blacklist']) {
      const list = changes['lz.blacklist'].newValue || [];
      state.blacklisted = list.includes(location.hostname);
      if (state.blacklisted) { hidePanel(); hideIcon(); closePalette(); }
    }
  });

  /* ---------------------------------------------------------------- */
  /* boot                                                             */
  /* ---------------------------------------------------------------- */

  function mount() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    injectStyles();
    document.body.appendChild(iconHost);
    document.body.appendChild(panelHost);
  }

  (async function init() {
    mount();

    try {
      const [settings, blacklist] = await Promise.all([
        api.storage.local.get('lz.settings'),
        api.storage.local.get('lz.blacklist')
      ]);
      state.settings = { ...state.settings, ...(settings['lz.settings'] || {}) };
      const list = blacklist['lz.blacklist'] || [];
      state.blacklisted = list.includes(location.hostname);
    } catch (e) { /* storage unavailable: keep defaults */ }
  })();
})();
