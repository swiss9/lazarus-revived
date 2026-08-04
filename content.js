const browser = globalThis.browser || globalThis.chrome;

(function() {
  if (!window.CSS || !window.CSS.escape) {
    window.CSS = window.CSS || {};
    window.CSS.escape = function(value) {
      if (arguments.length === 0) throw new TypeError('Failed to execute "escape" on "CSS": 1 argument required, but only 0 present.');
      var string = String(value);
      var length = string.length;
      var index = -1;
      var codeUnit;
      var result = '';
      while (++index < length) {
        codeUnit = string.charCodeAt(index);
        if (codeUnit === 0x0000) {
          result += '\uFFFD';
          continue;
        }
        if (
          (codeUnit >= 0x0001 && codeUnit <= 0x001F) ||
          (codeUnit === 0x007F) ||
          (codeUnit >= 0x0080 && codeUnit <= 0x009F) ||
          (codeUnit === 0x000D) ||
          (codeUnit === 0x000C)
        ) {
          result += '\\' + codeUnit.toString(16) + ' ';
          continue;
        }
        if (codeUnit === 0x005C) {
          result += '\\\\';
          continue;
        }
        if (
          (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (codeUnit >= 0x0041 && codeUnit <= 0x005A) ||
          (codeUnit >= 0x0061 && codeUnit <= 0x007A) ||
          (codeUnit === 0x002D) ||
          (codeUnit === 0x005F)
        ) {
          result += string.charAt(index);
          continue;
        }
        if (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) {
          result += '\\3' + string.charAt(index) + ' ';
          continue;
        }
        result += '\\' + codeUnit.toString(16) + ' ';
      }
      return result;
    };
  }
})();

let currentHostname = window.location.hostname;
let isBlacklisted = false;
let observerActive = false;
let observer;

async function refreshBlacklist() {
  const { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  const list = lazarus_blacklist || [];
  isBlacklisted = list.includes(currentHostname);
}

async function isVaultLocked() {
  const { lazarus_lock } = await browser.storage.local.get("lazarus_lock");
  return lazarus_lock === true;
}

const BIP39_WORDS = new Set([
  'abandon','ability','able','about','above','absent','absorb','abstract','absurd','accident','account','accuse','achieve','acid','acoustic','acquire','across','act','action','actor','actress','actual','adapt','add','addict','address','adjust','admit','adult','advance','advice','aerobic','affair','afford','afraid','africa','after','again','age','agent','agree','ahead','aim','air','airport','aisle','alarm','album','alcohol','alert','alien','all','alley','allow','almost','alone','alpha','already','also','alter','always','amateur','amazing','among','amount','amused','analyst','anchor','ancient','anger','angle','angry','animal','ankle','announce','annual','another','answer','antenna','antique','anxiety','any','apart','apology','appear','apple','approve','april','arch','arctic','area','arena','argue','arm','armed','armor','army','around','arrange','arrest','arrive','arrow','art','artefact','artist','artwork','ask','aspect','assault','asset','assist','assume','asthma','athlete','atom','attack','attend','attitude','attract','auction','audit','august','aunt','author','auto','autumn','average','avocado','avoid','awake','aware','away','awesome','awful','awkward','axis','baby','bachelor','bacon','badge','bag','balance','balcony','ball','bamboo','banana','banner','bar','barely','bargain','barrel','base','basic','basket','battle','beach','bean','beauty','because','become','beef','before','begin','behave','behind','believe','below','belt','bench','benefit','best','betray','better','between','beyond','bicycle','bid','bike','bind','biology','bird','birth','bitter','black','blade','blame','blanket','blast','bleak','bless','blind','blood','blossom','blouse','blue','blur','blush','board','boat','body','boil','bomb','bone','bonus','book','boost','border','boring','borrow','boss','bottom','bounce','box','boy','bracket','brain','brand','brass','brave','bread','breeze','brick','bridge','brief','bright','bring','brisk','broccoli','broken','bronze','broom','brother','brown','brush','bubble','buddy','budget','buffalo','build','bulb','bulk','bullet','bundle','bunker','burden','burger','burst','bus','business','busy','butter','buyer','buzz','cabbage','cabin','cable','cactus','cage','cake','call','calm','camera','camp','can','canal','cancel','candy','cannon','canoe','canvas','canyon','capable','capital','captain','car','carbon','card','cargo','carpet','carry','cart','case','cash','casino','castle','casual','cat','catalog','catch','category','cattle','caught','cause','caution','cave','ceiling','celery','cement','census','century','cereal','certain','chair','chalk','champion','change','chaos','chapter','charge','chase','chat','cheap','check','cheese','chef','cherry','chest','chicken','chief','child','chimney','choice','choose','chronic','chuckle','chunk','churn','cigar','cinnamon','circle','citizen','city','civil','claim','clap','clarify','claw','clay','clean','clerk','clever','click','client','cliff','climb','clinic','clip','clock','clog','close','cloth','cloud','clown','club','clump','cluster','clutch','coach','coast','coconut','code','coffee','coil','coin','collect','color','column','combine','come','comfort','comic','common','company','concert','conduct','confirm','congress','connect','consider','control','convince','cook','cool','copper','copy','coral','core','corn','correct','cost','cotton','couch','country','couple','course','cousin','cover','coyote','crack','cradle','craft','cram','crane','crash','crater','crawl','crazy','cream','credit','creek','crew','cricket','crime','crisp','critic','crop','cross','crouch','crowd','crucial','cruel','cruise','crumble','crunch','crush','cry','crystal','cube','culture','cup','cupboard','curious','current','curtain','curve','cushion','custom','cute','cycle','dad','damage','damp','dance','danger','daring','dash','daughter','dawn','day','deal','debate','debris','decade','december','decide','decline','decorate','decrease','deer','defense','define','defy','degree','delay','deliver','demand','demise','denial','dentist','deny','depart','depend','deposit','depth','deputy','derive','describe','desert','design','desk','despair','destroy','detail','detect','develop','device','devote','diagram','dial','diamond','diary','dice','diesel','diet','differ','digital','dignity','dilemma','dinner','dinosaur','direct','dirt','disagree','discover','disease','dish','dismiss','disorder','display','distance','divert','divide','divorce','dizzy','doctor','document','dog','doll','dolphin','domain','donate','donkey','donor','door','dose','double','dove','draft','dragon','drama','drastic','draw','dream','dress','drift','drill','drink','drip','drive','drop','drum','dry','duck','dumb','dune','during','dust','dutch','duty','dwarf','dynamic','eager','eagle','early','earn','earth','easily','east','easy','echo','ecology','economy','edge','edit','educate','effort','egg','eight','either','elbow','elder','electric','elegant','element','elephant','elevator','elite','else','embark','embody','embrace','emerge','emotion','employ','empower','empty','enable','enact','end','endless','endorse','enemy','energy','enforce','engage','engine','enhance','enjoy','enlist','enough','enrich','enroll','ensure','enter','entire','entry','envelope','episode','equal','equip','era','erase','erode','erosion','error','erupt','escape','essay','essence','estate','eternal','ethics','evidence','evil','evoke','evolve','exact','example','excess','exchange','excite','exclude','excuse','execute','exercise','exhaust','exhibit','exile','exist','exit','exotic','expand','expect','expire','explain','expose','express','extend','extra','eye','eyebrow','fabric','face','faculty','fade','faint','faith','fall','false','fame','family','famous','fan','fancy','fantasy','farm','fashion','fat','fatal','father','fatigue','fault','favorite','feature','february','federal','fee','feed','feel','female','fence','festival','fetch','fever','few','fiber','fiction','field','figure','file','film','filter','final','find','fine','finger','finish','fire','firm','first','fiscal','fish','fit','fitness','fix','flag','flame','flash','flat','flavor','flee','flight','flip','float','flock','floor','flower','fluid','flush','fly','foam','focus','fog','foil','fold','follow','food','foot','force','forest','forget','fork','fortune','forum','forward','fossil','foster','found','fox','fragile','frame','frequent','fresh','friend','fringe','frog','front','frost','frown','frozen','fruit','fuel','fun','funny','furnace','fury','future','gadget','gain','galaxy','gallery','game','gap','garage','garbage','garden','garlic','garment','gas','gasp','gate','gather','gauge','gaze','general','genius','genre','gentle','genuine','gesture','ghost','giant','gift','giggle','ginger','giraffe','girl','give','glad','glance','glare','glass','glide','glimpse','globe','gloom','glory','glove','glow','glue','goat','goddess','gold','good','goose','gorilla','gospel','gossip','govern','gown','grab','grace','grain','grant','grape','grass','gravity','great','green','grid','grief','grit','grocery','group','grow','grunt','guard','guess','guide','guilt','guitar','gun','gym','habit','hair','half','hammer','hamster','hand','happy','harbor','hard','harsh','harvest','hat','have','hawk','hazard','head','health','heart','heavy','hedgehog','height','hello','helmet','help','hen','hero','hidden','high','hill','hint','hip','hire','history','hobby','hockey','hold','hole','holiday','hollow','home','honey','hood','hope','horn','horror','horse','hospital','host','hotel','hour','hover','hub','huge','human','humble','humor','hundred','hungry','hunt','hurdle','hurry','hurt','husband','hybrid','ice','icon','idea','identify','idle','ignore','ill','illegal','illness','image','imitate','immense','immune','impact','impose','improve','impulse','inch','include','income','increase','index','indicate','indoor','industry','infant','inflict','inform','inhale','inherit','initial','inject','injury','inmate','inner','innocent','input','inquiry','insane','insect','inside','inspire','install','intact','interest','into','invest','invite','involve','iron','island','isolate','issue','item','ivory','jacket','jaguar','jar','jazz','jealous','jeans','jelly','jewel','job','join','joke','journey','joy','judge','juice','jump','jungle','junior','junk','just','kangaroo','keen','keep','ketchup','key','kick','kid','kidney','kind','kingdom','kiss','kit','kitchen','kite','kitten','kiwi','knee','knife','knock','know','lab','label','labor','ladder','lady','lake','lamp','language','laptop','large','later','latin','laugh','laundry','lava','law','lawn','lawsuit','layer','lazy','leader','leaf','learn','leave','lecture','left','leg','legal','legend','leisure','lemon','lend','length','lens','leopard','lesson','letter','level','liar','liberty','library','license','life','lift','light','like','limb','limit','link','lion','liquid','list','little','live','lizard','load','loan','lobster','local','lock','logic','lonely','long','loop','lottery','loud','lounge','love','loyal','lucky','luggage','lumber','lunar','lunch','luxury','lyrics','machine','mad','magic','magnet','maid','mail','main','major','make','mammal','man','manage','mandate','mango','mansion','manual','maple','marble','march','margin','marine','market','marriage','mask','mass','master','match','material','math','matrix','matter','maximum','maze','meadow','mean','measure','meat','mechanic','medal','media','melody','melt','member','memory','mention','menu','mercy','merge','merit','merry','mesh','message','metal','method','middle','midnight','milk','million','mimic','mind','minimum','minor','minute','miracle','mirror','misery','miss','mistake','mix','mixed','mixture','mobile','model','modify','mom','moment','monitor','monkey','monster','month','moon','moral','more','morning','mosquito','mother','motion','motor','mountain','mouse','move','movie','much','muffin','mule','multiply','muscle','museum','mushroom','music','must','mutual','myself','mystery','myth','naive','name','napkin','narrow','nasty','nation','nature','near','neck','need','negative','neglect','neither','nephew','nerve','nest','net','network','neutral','never','news','next','nice','night','noble','noise','nominee','noodle','normal','north','nose','notable','note','nothing','notice','novel','now','nuclear','number','nurse','nut','oak','obey','object','oblige','obscure','observe','obtain','obvious','occur','ocean','october','odor','off','offer','office','often','oil','okay','old','olive','olympic','omit','once','one','onion','online','only','open','opera','opinion','oppose','option','orange','orbit','orchard','order','ordinary','organ','orient','original','orphan','ostrich','other','outdoor','outer','output','outside','oval','oven','over','own','owner','oxygen','oyster','ozone','pact','paddle','page','pair','palace','palm','panda','panel','panic','panther','paper','parade','parent','park','parrot','party','pass','patch','path','patient','patrol','pattern','pause','pave','payment','peace','peanut','pear','peasant','pelican','pen','penalty','pencil','people','pepper','perfect','permit','person','pet','phone','photo','phrase','physical','piano','picnic','picture','piece','pig','pigeon','pill','pilot','pink','pioneer','pipe','pistol','pitch','pizza','place','planet','plastic','plate','play','please','pledge','pluck','plug','plunge','poem','poet','point','polar','pole','police','pond','pony','pool','popular','portion','position','possible','post','potato','pottery','poverty','powder','power','practice','praise','predict','prefer','prepare','present','pretty','prevent','price','pride','primary','print','priority','prison','private','prize','problem','process','produce','profit','program','project','promote','proof','property','prosper','protect','proud','provide','public','pudding','pull','pulp','pulse','pumpkin','punch','pupil','puppy','purchase','purity','purpose','purse','push','put','puzzle','pyramid','quality','quantum','quarter','question','quick','quit','quiz','quote','rabbit','raccoon','race','rack','radar','radio','rail','rain','raise','rally','ramp','ranch','random','range','rapid','rare','rate','rather','raven','raw','razor','ready','real','reason','rebel','rebuild','recall','receive','recipe','record','recycle','reduce','reflect','reform','refuse','region','regret','regular','reject','relax','release','relief','rely','remain','remember','remind','remove','render','renew','rent','reopen','repair','repeat','replace','report','require','rescue','resemble','resist','resource','response','result','retire','retreat','return','reunion','reveal','review','reward','rhythm','rib','ribbon','rice','rich','ride','ridge','rifle','right','rigid','ring','riot','ripple','risk','ritual','rival','river','road','roast','robot','robust','rocket','romance','roof','rookie','room','rose','rotate','rough','round','route','royal','rubber','rude','rug','rule','run','runway','rural','sad','saddle','sadness','safe','sail','salad','salmon','salon','salt','salute','same','sample','sand','satisfy','satoshi','sauce','sausage','save','say','scale','scan','scare','scatter','scene','scheme','school','science','scissors','scorpion','scout','scrap','screen','script','scrub','sea','search','season','seat','second','secret','section','security','seed','seek','segment','select','sell','seminar','senior','sense','sentence','series','service','session','settle','setup','seven','shadow','shaft','shallow','share','shed','shell','sheriff','shield','shift','shine','ship','shiver','shock','shoe','shoot','shop','short','shoulder','shove','shrimp','shrug','shuffle','shy','sibling','sick','side','siege','sight','sign','silent','silk','silly','silver','similar','simple','since','sing','siren','sister','situate','six','size','skate','sketch','ski','skill','skin','skirt','skull','slab','slam','sleep','slender','slice','slide','slight','slim','slogan','slot','slow','slush','small','smart','smile','smoke','smooth','snack','snake','snap','sniff','snow','soap','soccer','social','sock','soda','soft','solar','soldier','solid','solution','solve','someone','song','soon','sorry','sort','soul','sound','soup','source','south','space','spare','spatial','spawn','speak','special','speed','spell','spend','sphere','spice','spider','spike','spin','spirit','split','spoil','sponsor','spoon','sport','spot','spray','spread','spring','spy','square','squeeze','squirrel','stable','stadium','staff','stage','stairs','stamp','stand','start','state','stay','steak','steel','stem','step','stereo','stick','still','sting','stock','stomach','stone','stool','story','stove','strategy','street','strike','strong','struggle','student','stuff','stumble','style','subject','submit','subway','success','such','sudden','suffer','sugar','suggest','suit','summer','sun','sunny','sunset','super','supply','supreme','sure','surface','surge','surprise','surround','survey','suspect','sustain','swallow','swamp','swap','swarm','swear','sweet','swift','swim','swing','switch','sword','symbol','symptom','syrup','system','table','tackle','tag','tail','talent','talk','tank','tape','target','task','taste','tattoo','taxi','teach','team','tell','ten','tenant','tennis','tent','term','test','text','thank','that','theme','then','theory','there','they','thing','this','thought','three','thrive','throw','thumb','thunder','ticket','tide','tiger','tilt','timber','time','tiny','tip','tired','tissue','title','toast','tobacco','today','toddler','toe','together','toilet','token','tomato','tomorrow','tone','tongue','tonight','tool','tooth','top','topic','toss','total','tourist','toward','tower','town','toy','track','trade','traffic','tragic','train','transfer','trap','trash','travel','tray','treat','tree','trend','trial','tribe','trick','trigger','trim','trip','trophy','trouble','truck','true','truly','trumpet','trust','truth','try','tube','tuition','tumble','tuna','tunnel','turkey','turn','turtle','twelve','twenty','twice','twin','twist','two','type','typical','ugly','umbrella','unable','unaware','uncle','uncover','under','undo','unfair','unfold','unhappy','uniform','unique','unit','universe','unknown','unlock','until','unusual','unveil','update','upgrade','uphold','upon','upper','upset','urban','urge','usage','use','used','useful','useless','usual','utility','vacant','vacuum','vague','valid','valley','valve','van','vanish','vapor','various','vast','vault','vehicle','velvet','vendor','venture','venue','verb','verify','version','very','vessel','veteran','viable','vibrant','vicious','victory','video','view','village','vintage','violin','virtual','virus','visa','visit','visual','vital','vivid','vocal','voice','void','volcano','volume','vote','voyage','wage','wagon','wait','walk','wall','walnut','want','warfare','warm','warrior','wash','wasp','waste','water','wave','way','wealth','weapon','wear','weasel','weather','web','wedding','weekend','weird','welcome','west','wet','whale','what','wheat','wheel','when','where','whip','whisper','wide','width','wife','wild','will','win','window','wine','wing','wink','winner','winter','wire','wisdom','wise','wish','witness','wolf','woman','wonder','wood','wool','word','work','world','worry','worth','wrap','wreck','wrestle','wrist','write','wrong','yard','year','yellow','you','young','youth','zebra','zero','zone','zoo'
]);

const SECRET_REGEXES = [
  /sk_live_[0-9a-zA-Z]{24,99}/,
  /eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/,
  /-----BEGIN[\s\S]+?END .+ KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
  /xox[bprs]-[A-Za-z0-9-]+/,
  /AIza[0-9A-Za-z\-_]{35}/
];

function isSensitive(field) {
  if (isBlacklisted) return true;
  const type = (field.type || '').toLowerCase();
  if (type === 'password' || type === 'hidden') return true;
  const autocomplete = (field.getAttribute('autocomplete') || '').toLowerCase();
  if (autocomplete.includes('cc-') || autocomplete === 'one-time-code') return true;
  const name = (field.name || field.id || '').toLowerCase();
  const sensitiveNames = [
    'cvv', 'cardnumber', 'ssn', 'pin', 'ccnum', 'creditcard', 'cvc', 'expiry',
    'cryptoseed', 'seedphrase', 'mnemonic', 'seed', 'passphrase', 'bip39',
    'otp', 'one-time', 'verificationcode', 'authcode', 'securitycode'
  ];
  if (sensitiveNames.some(s => name.includes(s))) return true;
  const form = field.closest('form');
  if (form) {
    const action = (form.action || '').toLowerCase();
    if (action.includes('paypal') || action.includes('stripe') || action.includes('checkout') || action.includes('payment')) {
      if (name.includes('number') || name.includes('cvv') || name.includes('exp') || name.includes('card')) return true;
    }
  }
  const value = (field.value || field.textContent || '').trim();
  if (value && value.length <= 500) {
    const words = value.split(/\s+/);
    if (words.length === 12 || words.length === 15 || words.length === 18 || words.length === 21 || words.length === 24) {
      if (words.every(w => BIP39_WORDS.has(w.toLowerCase()))) return true;
    }
    if (value.length < 200 && SECRET_REGEXES.some(r => r.test(value))) return true;
  }
  return false;
}

function getFieldIdentifier(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) {
    const name = CSS.escape(el.name);
    const matches = document.querySelectorAll(`[name="${name}"]`);
    if (matches.length === 1) {
      return `[name="${name}"]`;
    }
  }
  let path = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    let selector = node.nodeName.toLowerCase();
    let nth = 1;
    let sibling = node;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.nodeName.toLowerCase() === node.nodeName.toLowerCase()) nth++;
    }
    selector += `:nth-of-type(${nth})`;
    path.unshift(selector);
    node = node.parentNode;
  }
  return path.join(' > ');
}

const saveTimers = new WeakMap();
const allTrackedFields = new WeakSet();
const fieldListeners = new WeakMap();

function saveField(field) {
  if (isSensitive(field)) return;
  if (field.type === 'search' || field.getAttribute('role') === 'searchbox') return;
  if (!field.isConnected) return;
  const text = (field.value || field.textContent || '').trim();
  if (!text || text.length < 4) return;
  const cleanUrl = window.location.origin + window.location.pathname;
  browser.runtime.sendMessage({
    action: "saveText",
    data: {
      pageUrl: cleanUrl,
      fieldName: getFieldIdentifier(field),
      text,
      timestamp: Date.now()
    }
  }).catch(err => console.warn('[Lazarus] save error:', err));
  field.classList.add('lazarus-saved-glow');
  setTimeout(() => field.classList.remove('lazarus-saved-glow'), 600);
}

function debouncedSave(field) {
  if (saveTimers.has(field)) clearTimeout(saveTimers.get(field));
  saveTimers.set(field, setTimeout(() => {
    saveField(field);
    saveTimers.delete(field);
  }, 500));
}

function attach(root) {
  if (isBlacklisted) return;
  const fields = root.querySelectorAll(
    'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]:not([contenteditable="false"])'
  );
  fields.forEach(field => {
    if (allTrackedFields.has(field) || isSensitive(field)) return;
    allTrackedFields.add(field);
    field.dataset.lazarusTracked = 'true';
    const listener = () => debouncedSave(field);
    fieldListeners.set(field, listener);
    field.addEventListener('input', listener);
  });
}

function detachAll() {
  if (observer) {
    observer.disconnect();
    observerActive = false;
  }
  document.querySelectorAll('[data-lazarus-tracked]').forEach(el => {
    const listener = fieldListeners.get(el);
    if (listener) {
      el.removeEventListener('input', listener);
      fieldListeners.delete(el);
    }
    if (saveTimers.has(el)) {
      clearTimeout(saveTimers.get(el));
      saveTimers.delete(el);
    }
    delete el.dataset.lazarusTracked;
    allTrackedFields.delete(el);
  });
  const iconHost = document.getElementById('lazarus-icon-host');
  if (iconHost) iconHost.style.display = 'none';
  const dropdownHost = document.getElementById('lazarus-dropdown-host');
  if (dropdownHost) dropdownHost.style.display = 'none';
}

function findFieldByIdentifier(identifier) {
  try {
    if (identifier.startsWith('#')) return document.getElementById(identifier.slice(1));
    if (identifier.startsWith('[name="')) {
      const name = identifier.slice(7, -2);
      return document.querySelector(`[name="${CSS.escape(name)}"]`);
    }
    return document.querySelector(identifier);
  } catch {
    return null;
  }
}

function restoreTextDirect(identifier, text) {
  if (typeof identifier !== 'string' || typeof text !== 'string' || !identifier) return;
  const field = findFieldByIdentifier(identifier);
  if (field) {
    if (field.isContentEditable) field.textContent = text;
    else field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.classList.add('lazarus-glow');
    setTimeout(() => field.classList.remove('lazarus-glow'), 600);
  }
}

(async function init() {
  await refreshBlacklist();
  attach(document);

  observer = new MutationObserver(mutations => {
    if (isBlacklisted) return;
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
          if (!allTrackedFields.has(node) && !isSensitive(node)) {
            allTrackedFields.add(node);
            node.dataset.lazarusTracked = 'true';
            const listener = () => debouncedSave(node);
            fieldListeners.set(node, listener);
            node.addEventListener('input', listener);
          }
        }
        if (node.querySelectorAll) attach(node);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  observerActive = true;

  browser.runtime.onMessage.addListener(msg => {
    if (msg.action === 'blacklist-changed') {
      refreshBlacklist().then(() => {
        if (isBlacklisted) {
          detachAll();
        } else {
          if (!observerActive) {
            observer.observe(document.body, { childList: true, subtree: true });
            observerActive = true;
          }
          attach(document);
        }
      });
    }
    if (msg.action === "restoreText") {
      if (!msg.data || typeof msg.data.fieldName !== 'string' || typeof msg.data.text !== 'string') return;
      restoreTextDirect(msg.data.fieldName, msg.data.text);
    }
    if (msg.action === "restoreAllTexts") {
      if (!Array.isArray(msg.data)) return;
      msg.data.forEach(item => {
        if (item && typeof item.fieldName === 'string' && typeof item.text === 'string') {
          restoreTextDirect(item.fieldName, item.text);
        }
      });
    }
    if (msg.action === "toggleCommandPalette") {
      toggleCommandPalette();
    }
  });

  (function injectGlowStyle() {
    if (document.getElementById('lazarus-glow-styles')) return;
    const style = document.createElement('style');
    style.id = 'lazarus-glow-styles';
    style.textContent = `.lazarus-glow { box-shadow: 0 0 10px 3px #D4AF37 !important; transition: box-shadow 0.3s ease-out; } .lazarus-saved-glow { background-color: #1a3a1a !important; transition: background-color 0.5s; }`;
    document.head.appendChild(style);
  })();

  if (!isBlacklisted) {
    (function mobileFriendlyInFieldUI() {
      const iconHost = document.createElement('div');
      iconHost.id = 'lazarus-icon-host';
      iconHost.style.cssText = 'position:fixed;display:none;z-index:2147483647;pointer-events:auto;';
      const shadowRoot = iconHost.attachShadow({ mode: 'open' });
      shadowRoot.innerHTML = `
        <style>
          :host { display: none; }
          .icon { width: 30px; height: 30px; background: #1A1A1D; color: #D4AF37; border-radius: 50%;
                  display: flex; align-items: center; justify-content: center; font-size: 18px;
                  cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.5); opacity: 0.9; transition: transform 0.1s; }
          .icon:hover { opacity: 1; transform: scale(1.05); }
          .icon:active { transform: scale(0.9); }
        </style>
        <div class="icon" role="button" aria-label="Lazarus restore form data" tabindex="0">☥</div>
      `;
      document.body.appendChild(iconHost);
      const iconBtn = shadowRoot.querySelector('.icon');

      const dropdownHost = document.createElement('div');
      dropdownHost.id = 'lazarus-dropdown-host';
      dropdownHost.style.cssText = 'position:fixed;display:none;z-index:2147483646;';
      const dropShadow = dropdownHost.attachShadow({ mode: 'open' });
      dropShadow.innerHTML = `
        <style>
          .list { background: #1A1A1D; color: #E0E0E0; border: 1px solid #D4AF37; border-radius: 8px;
                  min-width: 240px; max-width: 360px; max-height: 220px; overflow-y: auto;
                  font-family: sans-serif; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
          .item { display: flex; align-items: center; padding: 6px 8px; cursor: pointer; border-bottom: 1px solid #333; }
          .item:hover { background: #2A2A2D; color: #D4AF37; }
          .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
          .time { font-size: 11px; color: #9E9E9E; margin-right: 8px; white-space: nowrap; }
          .delete-btn { cursor: pointer; opacity: 0.6; background: none; border: none; color: #E0E0E0; font-size: 14px; padding: 0; margin-left: 4px; }
          .delete-btn:hover { opacity: 1; color: #D4AF37; }
        </style>
        <div class="list"></div>
      `;
      document.body.appendChild(dropdownHost);
      const listContainer = dropShadow.querySelector('.list');

      let activeField = null;
      let dropdownVisible = false;
      let iconVisible = false;
      let fieldJustFocused = false;
      let iconTouched = false;
      let fieldObserver = null;

      function startObservingField(field) {
        stopObservingField();
        if ('IntersectionObserver' in window) {
          fieldObserver = new IntersectionObserver((entries) => {
            if (iconVisible && activeField && activeField.isConnected) {
              positionIcon(activeField);
            }
          }, { threshold: 0 });
          fieldObserver.observe(field);
        }
      }

      function stopObservingField() {
        if (fieldObserver) {
          fieldObserver.disconnect();
          fieldObserver = null;
        }
      }

      function positionIcon(field) {
        if (isBlacklisted) return;
        const rect = field.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) { hideIcon(); return; }
        const isTextArea = field.tagName.toLowerCase() === 'textarea' || field.isContentEditable;
        const x = isTextArea ? rect.right - 32 : rect.right - 30;
        const y = isTextArea ? rect.bottom - 32 : rect.top + (rect.height / 2) - 15;
        iconHost.style.left = x + 'px';
        iconHost.style.top = y + 'px';
        iconHost.style.display = 'block';
        iconVisible = true;
      }

      function hideIcon() {
        if (dropdownVisible || iconTouched) return;
        iconHost.style.display = 'none';
        iconVisible = false;
        iconBtn.style.transform = 'scale(1)';
        stopObservingField();
      }

      function hideDropdown() {
        dropdownHost.style.display = 'none';
        dropdownVisible = false;
        iconBtn.style.transform = 'scale(1)';
      }

      async function deleteEntry(entryId) {
        await browser.runtime.sendMessage({ action: "deleteEntry", entryId });
        hideDropdown();
        hideIcon();
        if (activeField) showDropdown(activeField);
      }

      async function showDropdown(field) {
        if (isBlacklisted) return;
        dropdownVisible = true;
        try {
          const identifier = getFieldIdentifier(field);
          const { entries } = await browser.runtime.sendMessage({
            action: "getSavedData",
            currentTabUrl: window.location.origin + window.location.pathname,
            fieldName: identifier
          });
          listContainer.innerHTML = '';
          if (!entries || entries.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding:10px 12px;color:#9E9E9E;font-size:12px;text-align:center;';
            emptyMsg.textContent = 'No saved text for this field';
            listContainer.appendChild(emptyMsg);
          } else {
            entries[0].versions.slice().reverse().forEach(version => {
              const item = document.createElement('div');
              item.className = 'item';
              const textDiv = document.createElement('div');
              textDiv.className = 'text';
              textDiv.textContent = version.text.slice(0, 60) + (version.text.length > 60 ? '…' : '');
              const timeDiv = document.createElement('div');
              timeDiv.className = 'time';
              timeDiv.textContent = timeAgo(version.timestamp);
              const delBtn = document.createElement('button');
              delBtn.className = 'delete-btn';
              delBtn.textContent = '✕';
              delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteEntry(entries[0].id);
              });
              item.append(textDiv, timeDiv, delBtn);
              item.addEventListener('click', (e) => {
                if (e.target === delBtn) return;
                restoreTextDirect(entries[0].fieldName, version.text);
                hideDropdown();
                hideIcon();
                iconTouched = false;
              });
              listContainer.appendChild(item);
            });
          }
          const rect = field.getBoundingClientRect();
          const dropdownHeight = Math.min(listContainer.scrollHeight, 220);
          const spaceBelow = window.innerHeight - rect.bottom;
          const spaceAbove = rect.top;
          if (spaceBelow < dropdownHeight + 10 && spaceAbove > dropdownHeight + 10) {
            dropdownHost.style.top = (rect.top - dropdownHeight - 5) + 'px';
          } else {
            dropdownHost.style.top = (rect.bottom + 5) + 'px';
          }
          const dropdownWidth = 360;
          let left = rect.left;
          if (left + dropdownWidth > window.innerWidth) left = window.innerWidth - dropdownWidth - 5;
          if (left < 5) left = 5;
          dropdownHost.style.left = left + 'px';
          dropdownHost.style.display = 'block';
        } catch (err) { hideDropdown(); }
      }

      function timeAgo(ms) {
        const sec = Math.floor((Date.now() - ms) / 1000);
        if (sec < 60) return `${sec}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hrs = Math.floor(min / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return `${days}d ago`;
      }

      function onFieldActivate(field) {
        if (isBlacklisted) return;
        if (!allTrackedFields.has(field) || isSensitive(field)) return;
        activeField = field;
        fieldJustFocused = true;
        positionIcon(field);
        startObservingField(field);
        setTimeout(() => { fieldJustFocused = false; }, 300);
      }

      document.addEventListener('focusin', e => {
        if (isBlacklisted) return;
        const target = e.target;
        if (target.matches && target.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
          onFieldActivate(target);
        }
      }, true);

      document.addEventListener('touchstart', e => {
        if (isBlacklisted) return;
        const target = e.target;
        if (target.matches && target.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
          onFieldActivate(target);
        }
      }, { passive: true });

      document.addEventListener('focusout', () => {
        setTimeout(() => {
          if (!iconTouched && !dropdownVisible && !fieldJustFocused) hideIcon();
        }, 200);
      }, true);

      window.addEventListener('scroll', () => {
        if (activeField && iconVisible && !isBlacklisted) {
          positionIcon(activeField);
          if (dropdownVisible) hideDropdown();
        }
      }, { passive: true, capture: true });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dropdownVisible) {
          hideDropdown();
          hideIcon();
          iconTouched = false;
        }
      });

      iconBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        iconTouched = true;
        iconBtn.style.transform = 'scale(0.9)';
        if (activeField && activeField.isConnected && !isBlacklisted) showDropdown(activeField);
      });

      iconBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          iconBtn.click();
        }
      });

      document.addEventListener('click', (e) => {
        if (!iconHost.contains(e.target) && !dropdownHost.contains(e.target)) {
          hideDropdown();
          hideIcon();
          iconTouched = false;
        }
      }, true);
    })();
  }

  if (!isBlacklisted) {
    (function commandPalette() {
      const host = document.createElement('div');
      host.id = 'lazarus-cp-host';
      host.style.display = 'none';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');
      host.setAttribute('aria-label', 'Lazarus command palette');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483640;
                  background: rgba(0,0,0,0.5); display: flex; align-items: flex-start; justify-content: center; padding-top: 15vh; }
          .panel { background: #1A1A1D; border: 1px solid #D4AF37; border-radius: 12px; width: 90%; max-width: 500px;
                   overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,0.6); }
          .search-box { width: 100%; padding: 12px 16px; background: transparent; border: none; outline: none;
                        color: #E0E0E0; font-size: 16px; border-bottom: 1px solid #333; }
          .results { max-height: 300px; overflow-y: auto; }
          .cp-item { padding: 10px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;
                     border-bottom: 1px solid #27272a; color: #E0E0E0; font-size: 13px; }
          .cp-item:hover, .cp-item.active { background: #2A2A2D; color: #D4AF37; }
          .cp-field { font-weight: bold; color: #D4AF37; }
          .cp-snippet { color: #9E9E9E; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .locked { padding: 20px; text-align: center; color: #9E9E9E; font-size: 14px; }
        </style>
        <div class="panel">
          <input class="search-box" placeholder="Search drafts..." aria-label="Search Lazarus drafts">
          <div class="results"></div>
        </div>
      `;
      document.body.appendChild(host);

      const input = shadow.querySelector('.search-box');
      const results = shadow.querySelector('.results');
      let cpVisible = false;
      let allEntries = [];
      let selectedIndex = -1;

      function hide() {
        host.style.display = 'none';
        cpVisible = false;
        input.value = '';
        results.innerHTML = '';
        selectedIndex = -1;
      }

      async function show() {
        if (isBlacklisted) return;
        if (await isVaultLocked()) {
          results.innerHTML = '<div class="locked">🔒 Vault is locked</div>';
          host.style.display = 'flex';
          cpVisible = true;
          input.style.display = 'none';
          return;
        }
        input.style.display = '';
        host.style.display = 'flex';
        cpVisible = true;
        input.focus();
        loadEntries();
      }

      async function loadEntries() {
        const cleanUrl = window.location.origin + window.location.pathname;
        const resp = await browser.runtime.sendMessage({ action: "getSavedData", currentTabUrl: cleanUrl });
        allEntries = resp.entries || [];
        filterResults();
      }

      function filterResults() {
        const query = input.value.toLowerCase().trim();
        results.innerHTML = '';
        selectedIndex = -1;
        const filtered = allEntries.filter(e => {
          if (!query) return true;
          const latest = e.versions[e.versions.length - 1].text.toLowerCase();
          return e.fieldName.toLowerCase().includes(query) || latest.includes(query) || e.pageUrl.toLowerCase().includes(query);
        });
        filtered.forEach((entry, idx) => {
          const latest = entry.versions[entry.versions.length - 1];
          const item = document.createElement('div');
          item.className = 'cp-item';
          item.dataset.index = idx;
          item.innerHTML = `<span class="cp-field">${escapeHtml(entry.fieldName)}</span><span class="cp-snippet">${escapeHtml(latest.text.slice(0, 50))}</span>`;
          item.addEventListener('click', () => {
            restoreTextDirect(entry.fieldName, latest.text);
            hide();
          });
          results.appendChild(item);
        });
      }

      function updateSelection() {
        const items = results.querySelectorAll('.cp-item');
        items.forEach(item => item.classList.remove('active'));
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          items[selectedIndex].classList.add('active');
          items[selectedIndex].scrollIntoView({ block: 'nearest' });
        }
      }

      input.addEventListener('input', filterResults);
      host.addEventListener('click', (e) => {
        if (e.target === host) hide();
      });
      document.addEventListener('keydown', (e) => {
        if (!cpVisible) return;
        if (e.key === 'Escape') {
          hide();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const items = results.querySelectorAll('.cp-item');
          if (items.length === 0) return;
          selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
          updateSelection();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          updateSelection();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (selectedIndex >= 0) {
            const items = results.querySelectorAll('.cp-item');
            if (items[selectedIndex]) {
              items[selectedIndex].click();
            }
          }
        }
      });

      window.toggleCommandPalette = function() {
        if (cpVisible) hide();
        else show();
      };

      function escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, match => {
          const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
          return map[match];
        });
      }
    })();
  }
})();