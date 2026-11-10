/* معهد هدى للناس — الواجهة. كل المحتوى يأتي من الخادم (قاعدة البيانات) عبر /api */
(function () {
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https:\/\//i.test(u || '') ? u : '#');

const S = { site: null, user: null, enr: [], saved: [], sup: [], pre: null, route: 'home' };
const PAGES = ['home', 'programs', 'lessons', 'contact', 'login', 'signup', 'account', 'dashboard', 'terms'];
const cfg = k => (S.site.settings[k] || '');
const prog = k => S.site.programs.find(p => p.key === k);
const pname = k => (prog(k) ? prog(k).name : k);
const vid = id => S.site.videos.find(v => v.id === Number(id));
const hasFullAccess = () => !!S.user && (S.user.role === 'admin' || S.user.role === 'supervisor');
const isStaff = hasFullAccess;
const fmtDate = t => (t ? new Date(t * 1000).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const ROLE = { admin: 'مشرف', supervisor: 'مشرف', student: 'طالب' };
const GENDER = { male: 'ذكر', female: 'أنثى' };
const genderClass = gender => gender === 'male' || gender === 'female' ? gender : 'unspecified';
const genderIcon = () => '<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="7.5" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2z"/></svg>';
const genderBadge = gender => '<span class="gender-label ' + genderClass(gender) + '">' +
  genderIcon(gender) + esc(GENDER[gender] || 'غير محدد') + '</span>';

/* ───────── المظهر ───────── */
const THEME_KEY = 'mahad-theme';
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const toggle = $('#theme-toggle');
  toggle.innerHTML = dark
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z"/></svg>';
  const label = dark ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('#theme-toggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  });
}

/* ───────── الاتصال بالخادم ───────── */
async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opt); } catch (e) { throw new Error('تعذّر الاتصال بالخادم'); }
  let d = {};
  try { d = await r.json(); } catch (e) { /* فارغ */ }
  if (!r.ok) { const e = new Error(d.error || 'حدث خطأ'); e.status = r.status; throw e; }
  return d;
}
function setMe(d) { S.user = d.user || null; S.enr = d.enrollments || []; S.saved = d.saved || []; S.sup = d.programs || []; }
async function loadSite() { S.site = await api('GET', '/api/site'); }
async function loadMe() { setMe(await api('GET', '/api/me')); }

let toastT;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800);
}

/* ───────── مشغّل يوتيوب داخل الموقع ───────── */
let lastFocus = null;
function openVideo(id) {
  const v = vid(id);
  if (!v) return;
  lastFocus = document.activeElement;
  $('#mtitle').textContent = v.title;
  const box = $('#mplayer');
  if (v.youtube_id) {
    const q = '?rel=0&autoplay=1&hl=ar';
    const src = v.kind === 'playlist'
      ? 'https://www.youtube-nocookie.com/embed/videoseries?list=' + encodeURIComponent(v.youtube_id) + '&rel=0&autoplay=1&hl=ar'
      : 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(v.youtube_id) + q;
    box.innerHTML = '<iframe src="' + esc(src) + '" title="' + esc(v.title) + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
  } else {
    box.innerHTML = '<div class="mnone"><b>لم يُربط هذا الدرس بيوتيوب بعد</b><span>ستظهر المادة هنا فور إضافة الرابط.</span>' +
      (hasFullAccess() ? '<a class="btn" href="#dashboard" data-act="close-go" data-tab="videos">اربطه الآن من لوحة التحكم</a>'
        : '<a class="btn" href="' + esc(safeUrl(cfg('yt_playlists'))) + '" target="_blank" rel="noopener">تصفّح قناة الشيخ على يوتيوب</a>') + '</div>';
  }
  renderModalFoot(v);
  $('#modal').hidden = false;
  document.documentElement.classList.add('lock');
  $('.mclose').focus();
}
function renderModalFoot(v) {
  const saved = S.saved.indexOf(v.id) > -1;
  let h = '';
  if (S.user) h += '<button type="button" class="btn o sm" data-act="toggle-save" data-id="' + v.id + '">' + (saved ? '★ محفوظ في دروسي' : '☆ احفظ الدرس') + '</button>';
  else h += '<a class="btn o sm" href="#login" data-act="close-go">سجّل الدخول لحفظ الدروس</a>';
  if (v.url) h += '<a class="btn o sm" href="' + esc(v.url) + '" target="_blank" rel="noopener">فتح على يوتيوب</a>';
  if (v.description) h += '<p>' + esc(v.description) + '</p>';
  $('#mfoot').innerHTML = h;
}
function closeVideo() {
  if ($('#modal').hidden) return;
  $('#mplayer').innerHTML = '';
  $('#modal').hidden = true;
  document.documentElement.classList.remove('lock');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/* ───────── مكوّنات العرض ───────── */
const btn = (href, t, c, extra) => '<a class="btn ' + (c || '') + '" href="' + href + '"' + (extra || '') + '>' + esc(t) + '</a>';
const hero = (t, h, d, b, img) => '<div class="hero' + (img ? ' has-photo' : '') + '">' + (img ? '<img class="hi" src="' + esc(img) + '" alt="">' : '') +
  '<div class="tag">' + esc(cfg('hero_tag')) + '</div><h1>' + esc(t) + '</h1>' + (h ? '<h2>' + esc(h) + '</h2>' : '') + '<p>' + esc(d) + '</p><div class="hero-actions">' + b + '</div></div>';
const secHead = (t, s) => '<h3 class="t">' + esc(t) + '</h3><p class="sub">' + (esc(s) || '&nbsp;') + '</p>';

function vcard(v) {
  const sub = v.description || ((v.kind === 'playlist' ? 'قائمة تشغيل' : 'فيديو') + ' · ' + cfg('sheikh_name'));
  return '<button type="button" class="pl" data-play="' + v.id + '"><div class="th">' +
    (v.thumb_url ? '<img src="' + esc(v.thumb_url) + '" alt="" loading="lazy">' : '') +
    (v.youtube_id ? '' : '<span class="soon">قريبًا</span>') + '<span class="play">▶</span></div>' +
    '<div class="pi"><h4>' + esc(v.title) + '</h4><p>' + esc(sub) + '</p></div></button>';
}
const vgrid = list => '<div class="grid vg">' + list.map(vcard).join('') + '</div>';

function viewHome() {
  const P = S.site.programs, V = S.site.videos;
  let o = hero(cfg('hero_title'), cfg('hero_subtitle'), cfg('hero_text'),
    btn('#programs', 'تعرّف على البرامج') + (S.user ? btn('#account', 'حسابي', 'o') : btn('#signup', 'إنشاء حساب', 'o')), '/img/sheikh.jpg');
  o += '<section id="programs">' + secHead(cfg('programs_title'), cfg('programs_sub')) + '<div class="grid">' +
    P.map(p => '<div class="card">' + (p.cover ? '<img class="cv" src="' + esc(p.cover) + '" alt="">' : '') + '<h4>برنامج ' + esc(p.name) + '</h4><p>' + esc(p.audience) + '</p>' + btn('#' + p.key, 'تعرّف على البرنامج') + '</div>').join('') +
    '</div></section>';
  const lec = V.filter(v => v.home_section === 'lectures');
  if (lec.length) o += '<section class="dark"><div>' + secHead(cfg('lectures_title'), cfg('lectures_sub')) + vgrid(lec) + '<p class="sub">' + btn('#lessons', 'كل الدروس', 'o') + '</p></div></section>';
  if (S.site.faqs.length) o += '<section>' + secHead('أسئلة شائعة', '') + S.site.faqs.map(f => '<details><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>').join('') + '</section>';
  const ben = V.filter(v => v.home_section === 'benefit');
  if (ben.length) o += '<section>' + secHead(cfg('benefit_title'), cfg('benefit_sub')) + vgrid(ben) + '</section>';
  return o + '<div class="cta"><h3>' + esc(cfg('cta_title')) + '</h3><p>' + esc(cfg('cta_text')) + '</p>' +
    btn(esc(safeUrl(cfg('yt_channel'))), 'قناة يوتيوب', 'r', ' target="_blank" rel="noopener"') + btn(S.user ? '#account' : '#signup', 'ابدأ رحلتك العلمية') + '</div>';
}

function joinButton(p) {
  if (isStaff()) return '';
  if (!S.user) return btn('#signup', 'انضم إلى البرنامج', '', ' data-act="pre" data-key="' + esc(p.key) + '"');
  const e = S.enr.find(x => x.program_key === p.key);
  if (e) return '<span class="badge ' + (e.status === 'active' ? 'ok' : 'wait') + '">' + (e.status === 'active' ? 'أنت مسجّل في هذا البرنامج ✓' : 'طلب انضمامك قيد المراجعة') + '</span>';
  return '<button type="button" class="btn" data-act="enroll" data-key="' + esc(p.key) + '">انضم إلى البرنامج</button>';
}

function viewProgram(p) {
  let o = hero('برنامج ' + p.name, p.headline, p.description + (p.audience ? ' (' + p.audience + ')' : ''),
    joinButton(p) + ' ' + btn('#contact', 'اسأل عن البرنامج', 'o'), p.cover);
  if (p.axes.length) o += '<section>' + secHead('محاور البرنامج', '') + '<div class="grid">' + p.axes.map(a => '<div class="card"><h4>' + esc(a.title) + '</h4><p>' + esc(a.body) + '</p></div>').join('') + '</div></section>';
  if (p.plan.length) o += '<section>' + secHead('خطة مقترحة قابلة للتعديل', 'تنظيم مقترح للمتابعة؛ يُراجع وفق دليل البرنامج') + '<div class="tbl"><table><tr><th>المرحلة</th><th>المحور</th><th>النشاط</th></tr>' +
    p.plan.map((x, i) => '<tr><td>المرحلة ' + (i + 1) + '</td><td>' + esc(x.stage) + '</td><td>' + esc(x.activity) + '</td></tr>').join('') +
    '</table></div><div class="note">الخطة مقترحة وتُعدّل بحسب إرشادات القناة الرسمية.</div></section>';
  const vs = S.site.videos.filter(v => v.program_key === p.key);
  if (vs.length) o += '<section>' + secHead('من دروس الشيخ', 'تُشاهد هنا داخل الموقع دون مغادرته') + vgrid(vs) + '</section>';
  return o;
}

let LF = { q: '', p: '' };
function lessonsGrid() {
  const q = LF.q.trim().toLowerCase();
  const list = S.site.videos.filter(v => (!LF.p || v.program_key === LF.p) && (!q || (v.title + ' ' + v.description).toLowerCase().indexOf(q) > -1));
  return list.length ? vgrid(list) : '<p class="sub">لا توجد نتائج مطابقة.</p>';
}
function viewLessons() {
  return '<section>' + secHead('الدروس والمحاضرات', 'شاهد دروس الشيخ حسين عبد الرازق داخل الموقع') +
    '<input class="search" id="lsearch" type="search" placeholder="ابحث في الدروس…" value="' + esc(LF.q) + '">' +
    '<div class="chips" id="lchips">' + chips() + '</div><div id="lgrid">' + lessonsGrid() + '</div></section>';
}
function chips() {
  return ['<button type="button" data-act="lfilter" data-p=""' + (LF.p === '' ? ' class="on"' : '') + '>الكل</button>']
    .concat(S.site.programs.map(p => '<button type="button" data-act="lfilter" data-p="' + esc(p.key) + '"' + (LF.p === p.key ? ' class="on"' : '') + '>' + esc(p.name) + '</button>')).join('');
}

function viewContact() {
  const u = S.user || {};
  return hero('تواصل معنا', '', cfg('contact_text'), '') +
    '<section><div class="grid"><form class="form form-wide" data-form="contact"><h3>أرسل لنا رسالتك</h3>' +
    '<label for="c1">الاسم الكريم</label><input id="c1" name="name" maxlength="80" value="' + esc(u.name || '') + '" placeholder="أدخل اسمك هنا...">' +
    '<label for="c2">معرّف التليجرام</label><input id="c2" name="telegram" dir="ltr" maxlength="64" value="' + (u.username ? '@' + esc(u.username) : '') + '" placeholder="@username">' +
    '<label for="c3">رسالتك</label><textarea id="c3" name="message" rows="5" maxlength="3000" placeholder="اكتب رسالتك أو استفسارك هنا..."></textarea>' +
    '<button class="btn" type="submit">إرسال الرسالة</button><div class="msg"></div></form><div class="stack">' +
    '<div class="card"><h4>قناة المعهد الرسمية</h4><p>أخبار المعهد والبرامج والمستجدات</p>' + btn(esc(safeUrl(cfg('tg_institute'))), cfg('tg_institute').replace(/^https?:\/\//, ''), '', ' target="_blank" rel="noopener"') + '</div>' +
    '<div class="card"><h4>قناة الشيخ حسين عبد الرازق</h4><p>دروس ومحاضرات وعلوم السنة والقرآن</p>' + btn(esc(safeUrl(cfg('tg_sheikh'))), cfg('tg_sheikh').replace(/^https?:\/\//, ''), '', ' target="_blank" rel="noopener"') + '</div>' +
    '<div class="card"><h4>قناة الشيخ على يوتيوب</h4><p>دروس مرئية وسلاسل علمية متكاملة</p>' + btn(esc(safeUrl(cfg('yt_channel'))), cfg('yt_channel').replace(/^https?:\/\//, ''), 'r', ' target="_blank" rel="noopener"') + '</div></div></div></section>';
}

function viewLogin() {
  return '<form class="form" data-form="login"><h3>تسجيل الدخول</h3><p class="formsub">ادخل إلى منصة ' + esc(cfg('site_name')) + '</p>' +
    '<label for="l1">معرّف تيليجرام</label><input id="l1" name="username" dir="ltr" autocomplete="username" placeholder="@ahmed_abdullah">' +
    '<label for="l2">كلمة المرور</label><input id="l2" name="password" type="password" autocomplete="current-password">' +
    '<button class="btn" type="submit">دخول</button><div class="msg"></div>' +
    btn(esc(safeUrl(cfg('yt_channel'))), 'قناة الشيخ على يوتيوب', 'r block', ' target="_blank" rel="noopener"') +
    '<p class="formsub">ليس لديك حساب؟ <a class="lnk" href="#signup">سجّل هنا</a></p></form>';
}
function viewSignup() {
  const pre = S.pre;
  return '<form class="form" data-form="signup"><h3>إنشاء حساب</h3><p class="formsub">أنشئ حسابك، واستخدم معرف تيليجرام للدخول بدل البريد الإلكتروني.</p>' +
    '<label for="s1">الاسم الكامل</label><input id="s1" name="name" maxlength="80" autocomplete="name" placeholder="أحمد عبد الله">' +
    '<label for="s2">معرف تيليجرام</label><input id="s2" name="username" dir="ltr" autocomplete="username" placeholder="@ahmed_abdullah">' +
    '<fieldset class="gender-group"><legend>النوع</legend><div class="gender-options">' +
    '<label class="gender-choice"><input type="radio" name="gender" value="male" required> <span>ذكر</span></label>' +
    '<label class="gender-choice"><input type="radio" name="gender" value="female" required> <span>أنثى</span></label></div></fieldset>' +
    '<label for="s3">كلمة المرور (٨ أحرف على الأقل)</label><input id="s3" name="password" type="password" autocomplete="new-password">' +
    '<label for="s4">تأكيد كلمة المرور</label><input id="s4" name="password2" type="password" autocomplete="new-password">' +
    '<label>البرامج التي ترغب بالانضمام إليها (اختياري)</label><div class="ckw">' +
    S.site.programs.map(p => '<label class="ckl"><input type="checkbox" data-multi name="programs" value="' + esc(p.key) + '"' + (pre === p.key ? ' checked' : '') + '> ' + esc(p.name) + '</label>').join('') + '</div>' +
    '<label class="ckl"><input type="checkbox" name="terms"> الموافقة على <a class="lnk" href="/#terms" target="_blank" rel="noopener">شروط الاستخدام وسياسة الخصوصية</a></label>' +
    '<button class="btn" type="submit">إنشاء حساب</button><div class="msg"></div>' +
    '<p class="formsub">لديك حساب؟ <a class="lnk" href="#login">تسجيل الدخول</a></p></form>';
}
const viewTerms = () => '<section class="narrow">' + secHead('شروط الاستخدام وسياسة الخصوصية', '') + '<div class="card terms">' + esc(cfg('terms_text')) + '</div></section>';

function viewAccount() {
  const u = S.user;
  const ini = u.name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('');
  let o = '<section><div class="card"><div class="prof"><div class="av">' + esc(ini) + '</div><div><h3 class="h0">' + esc(u.name) + '</h3>' +
    '<div class="muted"><span dir="ltr">@' + esc(u.username) + '</span> · ' + ROLE[u.role] + (u.gender ? ' · ' + esc(GENDER[u.gender]) : '') + (u.city ? ' · ' + esc(u.city) : '') + '</div>' +
    (u.bio ? '<div class="muted">' + esc(u.bio) + '</div>' : '') + '</div></div>' +
    (isStaff() ? '<div class="acts">' + btn('#dashboard', 'لوحة التحكم', 'sm') + '</div>' : '') +
    '<details><summary>تعديل بياناتي</summary><form class="inl" data-form="profile">' +
    fld('name', 'الاسم', u.name) + fld('city', 'المدينة', u.city) + fld('bio', 'نبذة عنك', u.bio, { type: 'area' }) +
    '<button class="btn sm" type="submit">حفظ</button> <span class="msg"></span></form></details>' +
    '<details><summary>تغيير كلمة المرور</summary><form class="inl" data-form="password">' +
    fld('old', 'كلمة المرور الحالية', '', { type: 'password' }) + fld('new', 'كلمة المرور الجديدة (٨ أحرف على الأقل)', '', { type: 'password' }) +
    '<button class="btn sm" type="submit">تغيير</button> <span class="msg"></span></form></details></div>';
  if (u.role === 'student') {
    o += '<br><div class="card"><h4>برامجي (' + S.enr.length + ')</h4>';
    o += S.enr.length ? '<div class="grid">' + S.enr.map(e => '<div class="card"><h4>برنامج ' + esc(pname(e.program_key)) + '</h4><p><span class="badge ' + (e.status === 'active' ? 'ok' : 'wait') + '">' + (e.status === 'active' ? 'مسجّل · نشط' : 'بانتظار موافقة المشرف') + '</span></p>' +
      btn('#' + esc(e.program_key), 'متابعة البرنامج') + (e.status === 'pending' ? '<button type="button" class="btn ghost sm" data-act="unenroll" data-key="' + esc(e.program_key) + '">إلغاء الطلب</button>' : '') + '</div>').join('') + '</div>' : '<p class="muted">لم تنضم إلى أي برنامج بعد.</p>';
    const rest = S.site.programs.filter(p => !S.enr.some(e => e.program_key === p.key));
    if (rest.length) o += '<div class="acts">' + rest.map(p => '<button type="button" class="btn o sm" data-act="enroll" data-key="' + esc(p.key) + '">+ ' + esc(p.name) + '</button>').join('') + '</div>';
    o += '</div>';
  }
  const sv = S.saved.map(vid).filter(Boolean);
  o += '<br><div class="card"><h4>دروسي المحفوظة (' + sv.length + ')</h4>' + (sv.length ? vgrid(sv) : '<p class="muted">افتح أي درس واضغط «احفظ الدرس» ليظهر هنا.</p>') + '</div></section>';
  return o;
}

/* ───────── أدوات النماذج ───────── */
function fld(name, label, val, o) {
  o = o || {};
  const id = 'f' + Math.random().toString(36).slice(2, 9), type = o.type || 'text';
  const dir = o.dir ? ' dir="' + o.dir + '"' : '', ph = o.ph ? ' placeholder="' + esc(o.ph) + '"' : '';
  if (type === 'check') return '<label class="fld ckl"><input type="checkbox" name="' + name + '"' + (val ? ' checked' : '') + '> ' + esc(label) + '</label>';
  let input;
  if (type === 'area') input = '<textarea id="' + id + '" name="' + name + '"' + dir + ph + '>' + esc(val) + '</textarea>';
  else if (type === 'select') input = '<select id="' + id + '" name="' + name + '">' + o.opts.map(x => '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(val) ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select>';
  else input = '<input id="' + id + '" name="' + name + '" type="' + type + '" value="' + esc(val) + '"' + dir + ph + (o.ro ? ' readonly' : '') + '>';
  return '<label class="fld" for="' + id + '">' + esc(label) + '</label>' + input + (o.hint ? '<div class="muted">' + o.hint + '</div>' : '');
}
const imgFld = (name, label, val) => '<label class="fld">' + esc(label) + '</label>' + (val ? '<img class="thumbprev" src="' + esc(val) + '" alt="">' : '') +
  '<input name="' + name + '" type="text" dir="ltr" value="' + esc(val) + '" placeholder="/img/... أو ارفع صورة"><input type="file" accept="image/jpeg,image/png,image/webp" data-upload="' + name + '">';
function readForm(f) {
  const o = {};
  $$('[name]', f).forEach(el => {
    const n = el.name;
    if (el.type === 'radio') {
      if (el.checked) o[n] = el.value;
    } else if (el.type === 'checkbox') {
      if (el.hasAttribute('data-multi')) { o[n] = o[n] || []; if (el.checked) o[n].push(el.value); } else o[n] = el.checked;
    } else if (el.type === 'number') o[n] = parseInt(el.value, 10) || 0;
    else if (el.type !== 'file') o[n] = el.value;
  });
  return o;
}
const progBoxes = (sel, attr) => '<div class="ckw">' + S.site.programs.map(p => '<label class="ckl"><input type="checkbox" ' + attr + ' value="' + esc(p.key) + '"' + (sel.indexOf(p.key) > -1 ? ' checked' : '') + '> ' + esc(p.name) + '</label>').join('') + '</div>';
const progOpts = () => [['', 'بدون']].concat(S.site.programs.map(p => [p.key, p.name]));

/* ───────── لوحة التحكم ───────── */
let DT = 'overview';
const TABS = { overview: 'نظرة عامة', students: 'الطلاب', supervisors: 'المشرفون', messages: 'الرسائل', videos: 'الفيديوهات', programs: 'البرامج', faqs: 'الأسئلة الشائعة', outbox: 'الصادر', settings: 'الإعدادات' };
const tabList = () => Object.keys(TABS);
const SET_FIELDS = [['site_name', 'اسم الموقع'], ['sheikh_name', 'السطر أسفل الشعار'], ['hero_tag', 'وسم الصفحة الرئيسية'], ['hero_title', 'عنوان الصفحة الرئيسية'], ['hero_subtitle', 'العنوان الفرعي'], ['hero_text', 'نص التعريف', 'area'],
  ['programs_title', 'عنوان قسم البرامج'], ['programs_sub', 'وصف قسم البرامج'], ['lectures_title', 'عنوان قسم الدروس'], ['lectures_sub', 'وصف قسم الدروس'], ['benefit_title', 'عنوان قسم «كيف ينتفع»'], ['benefit_sub', 'وصفه'],
  ['cta_title', 'عنوان الدعوة للانضمام'], ['cta_text', 'نص الدعوة للانضمام'], ['contact_text', 'نص صفحة التواصل'], ['footer_about', 'تعريف أسفل الصفحة', 'area'], ['copyright', 'حقوق النشر'],
  ['tg_institute', 'رابط قناة المعهد (تيليجرام)', 'url'], ['tg_sheikh', 'رابط قناة الشيخ (تيليجرام)', 'url'], ['yt_channel', 'رابط قناة يوتيوب', 'url'], ['yt_playlists', 'رابط قوائم التشغيل على يوتيوب', 'url'], ['terms_text', 'نص الشروط وسياسة الخصوصية', 'area']];

const stat = (n, l) => '<div class="stat"><span class="num">' + esc(n) + '</span>' + esc(l) + '</div>';
const DR = {};
DR.overview = async () => {
  const s = await api('GET', '/api/admin/stats');
  let o = '<div class="stats">' + stat(s.students, 'طالب') + stat(s.supervisors, 'مشرف') + stat(s.videos, 'درس/قائمة') + stat(s.unread, 'رسالة جديدة') + stat(s.outbox, 'بانتظار الإرسال') + '</div>';
  if (s.unlinked) o += '<div class="note">' + s.unlinked + ' من الدروس غير مربوطة بيوتيوب بعد — <a class="lnk" href="#" data-act="tab" data-tab="videos">اربطها الآن</a> لتعمل داخل الموقع.</div><br>';
  o += '<div class="card"><b>الطلاب في كل برنامج</b><div class="tw"><table><tr><th>البرنامج</th><th>نشط</th><th>بانتظار الموافقة</th></tr>' +
    s.programs.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + p.active + '</td><td>' + p.pending + '</td></tr>').join('') + '</table></div></div>';
  return o;
};
DR.students = async () => {
  const { students } = await api('GET', '/api/admin/students');
  if (!students.length) return '<div class="card"><p class="muted">لا يوجد طلاب بعد.</p></div>';
  const allowed = S.site.programs.map(p => p.key);
  return '<input class="search" id="stsearch" type="search" placeholder="ابحث بالاسم أو المعرّف…"><div class="card"><b>الطلاب (' + students.length + ')</b>' + students.map(s => {
    const en = {}; s.enrollments.forEach(e => { en[e.program_key] = e; });
    const sent = s.enrollments.filter(e => e.sent_at).map(e => pname(e.program_key));
    return '<div class="rw" data-id="' + s.id + '" data-q="' + esc((s.name + ' ' + s.username).toLowerCase()) + '"><b>' + esc(s.name) + '</b> ' + genderBadge(s.gender) + ' <span class="muted" dir="ltr">@' + esc(s.username) + '</span> <span class="muted">· ' + fmtDate(s.created_at) + (s.city ? ' · ' + esc(s.city) : '') + '</span>' +
      '<div class="ckw">' + S.site.programs.map(p => '<label class="ckl"><input type="checkbox" data-p value="' + esc(p.key) + '"' + (en[p.key] ? ' checked' : '') + (allowed.indexOf(p.key) < 0 ? ' disabled' : '') + '> ' + esc(p.name) + (en[p.key] && en[p.key].status === 'pending' ? ' <span class="badge wait">طلب</span>' : '') + '</label>').join('') + '</div>' +
      '<div class="acts"><button type="button" class="btn sm" data-act="st-save">حفظ البرامج</button><button type="button" class="btn o sm" data-act="st-send">إرسال إلى البرامج</button>' +
      '<button type="button" class="btn ghost sm" data-act="u-pass">كلمة مرور جديدة</button><button type="button" class="btn ghost sm" data-act="u-del">حذف</button>' +
      '<span class="muted">' + (sent.length ? 'تم الإرسال إلى: ' + esc(sent.join('، ')) : 'لم يُرسل بعد') + '</span></div></div>';
  }).join('') + '</div>';
};
DR.supervisors = async () => {
  const { supervisors } = await api('GET', '/api/admin/supervisors');
  return '<div class="note">جميع المشرفين لديهم صلاحيات كاملة لإدارة الموقع، بما في ذلك الطلاب والبرامج والإعدادات والمشرفين الآخرين.</div><br>' +
    '<form class="card" data-form="sup"><b>إضافة مشرف</b>' + fld('name', 'اسم المشرف', '') + fld('username', 'معرّف تيليجرام', '', { dir: 'ltr', ph: '@username' }) +
    fld('password', 'كلمة مرور مؤقتة (٨ أحرف على الأقل)', '', { type: 'password' }) +
    '<div class="acts"><button class="btn" type="submit">إضافة مشرف</button><span class="msg"></span></div></form><br><div class="card"><b>المشرفون (' + supervisors.length + ')</b>' +
    (supervisors.map(s => '<div class="rw" data-id="' + s.id + '"><b>' + esc(s.name) + '</b> <span class="badge ok">صلاحية كاملة</span> <span class="muted" dir="ltr">@' + esc(s.username) + '</span>' +
      '<div class="acts"><button type="button" class="btn ghost sm" data-act="u-pass">كلمة مرور جديدة</button>' +
      (s.id === S.user.id ? '<span class="muted">هذا حسابك</span>' : '<button type="button" class="btn ghost sm" data-act="u-del">حذف</button>') + '</div></div>').join('') || '<p class="muted">لا يوجد مشرفون بعد.</p>') + '</div>';
};
DR.messages = async () => {
  const { messages } = await api('GET', '/api/admin/messages');
  return '<div class="card"><b>رسائل التواصل (' + messages.length + ')</b>' + (messages.map(m => '<div class="msgbox' + (m.is_read ? '' : ' unread') + '" data-id="' + m.id + '"><b>' + esc(m.name) + '</b> <span class="muted" dir="ltr">' + esc(m.telegram) + '</span> <span class="muted">· ' + fmtDate(m.created_at) + '</span><p>' + esc(m.body) + '</p>' +
    '<div class="acts">' + (m.is_read ? '' : '<button type="button" class="btn sm" data-act="msg-read">تمت القراءة</button>') + '<button type="button" class="btn ghost sm" data-act="msg-del">حذف</button></div></div>').join('') || '<p class="muted">لا توجد رسائل.</p>') + '</div>';
};
function videoForm(v) {
  v = v || { title: '', url: '', thumb: '', home_section: '', program_key: '', description: '', sort: 0, published: true };
  return fld('title', 'العنوان', v.title) + fld('url', 'رابط يوتيوب (فيديو أو قائمة تشغيل)', v.url, { dir: 'ltr', ph: 'https://www.youtube.com/playlist?list=...', hint: 'للقائمة استخدم رابط «playlist?list=…»، وللفيديو رابط «watch?v=…» أو youtu.be. اتركه فارغًا إن لم يتوفر الرابط بعد.' }) +
    '<div class="row2"><div>' + fld('home_section', 'مكان الظهور في الرئيسية', v.home_section, { type: 'select', opts: [['', 'لا يظهر في الرئيسية'], ['lectures', 'الدروس والمحاضرات'], ['benefit', 'كيف ينتفع طالب العلم']] }) + '</div><div>' +
    fld('program_key', 'البرنامج المرتبط', v.program_key, { type: 'select', opts: progOpts() }) + '</div></div>' + fld('description', 'وصف قصير (اختياري)', v.description) +
    imgFld('thumb', 'صورة مصغرة (اختياري — للفيديو المفرد تُجلب تلقائيًا)', v.thumb) + fld('sort', 'الترتيب', v.sort, { type: 'number' }) + fld('published', 'منشور', v.published, { type: 'check' });
}
DR.videos = async () => {
  const { videos } = await api('GET', '/api/admin/videos');
  return '<details class="card" open><summary><b>+ إضافة درس أو قائمة تشغيل</b></summary><form data-form="video">' + videoForm() + '<div class="acts"><button class="btn" type="submit">إضافة</button><span class="msg"></span></div></form></details><br>' +
    '<div class="card"><b>الدروس (' + videos.length + ')</b>' + videos.map(v => '<details><summary>' + esc(v.title) + ' <span class="badge">' + (v.kind === 'playlist' ? 'قائمة' : 'فيديو') + '</span> ' +
      (v.youtube_id ? '<span class="badge ok">مربوط</span>' : '<span class="badge wait">غير مربوط</span>') + (v.published ? '' : ' <span class="badge">مخفي</span>') + '</summary><form data-form="video" data-id="' + v.id + '">' + videoForm(v) +
      '<div class="acts"><button class="btn sm" type="submit">حفظ</button><button type="button" class="btn ghost sm" data-act="vid-del" data-id="' + v.id + '">حذف</button><span class="msg"></span></div></form></details>').join('') + '</div>';
};
const pairsText = (a, k1, k2) => a.map(x => x[k1] + ' | ' + x[k2]).join('\n');
function programForm(p, isNew) {
  p = p || { key: '', name: '', headline: '', audience: '', description: '', cover: '', sort: 0, active: true, axes: [], plan: [] };
  return (isNew ? fld('key', 'المفتاح (إنجليزي صغير، يظهر في الرابط)', '', { dir: 'ltr', ph: 'quran2' }) : '') + fld('name', 'اسم البرنامج', p.name) + fld('headline', 'العنوان الفرعي', p.headline) + fld('audience', 'الفئة المستهدفة', p.audience) +
    fld('description', 'الوصف', p.description, { type: 'area' }) + imgFld('cover', 'صورة البرنامج', p.cover) +
    fld('axes', 'محاور البرنامج — سطر لكل محور بالشكل: العنوان | الوصف', pairsText(p.axes, 'title', 'body'), { type: 'area' }) +
    fld('plan', 'الخطة المقترحة — سطر لكل مرحلة بالشكل: المحور | النشاط', pairsText(p.plan, 'stage', 'activity'), { type: 'area' }) +
    fld('sort', 'الترتيب', p.sort, { type: 'number' }) + fld('active', 'ظاهر في الموقع', p.active, { type: 'check' });
}
DR.programs = async () => {
  const { programs } = await api('GET', '/api/admin/programs');
  return '<details class="card"><summary><b>+ إضافة برنامج جديد</b></summary><form data-form="program">' + programForm(null, true) + '<div class="acts"><button class="btn" type="submit">إضافة</button><span class="msg"></span></div></form></details><br>' +
    '<div class="card"><b>البرامج (' + programs.length + ')</b>' + programs.map(p => '<details><summary>' + esc(p.name) + (p.active ? '' : ' <span class="badge">مخفي</span>') + '</summary><form data-form="program" data-key="' + esc(p.key) + '">' + programForm(p) +
      '<div class="acts"><button class="btn sm" type="submit">حفظ</button><button type="button" class="btn ghost sm" data-act="prog-del" data-key="' + esc(p.key) + '">حذف</button><span class="msg"></span></div></form></details>').join('') + '</div>';
};
DR.faqs = async () => {
  const { faqs } = await api('GET', '/api/admin/faqs');
  const form = f => fld('q', 'السؤال', f ? f.q : '') + fld('a', 'الجواب', f ? f.a : '', { type: 'area' }) + fld('sort', 'الترتيب', f ? f.sort : 0, { type: 'number' });
  return '<details class="card" open><summary><b>+ إضافة سؤال</b></summary><form data-form="faq">' + form() + '<div class="acts"><button class="btn" type="submit">إضافة</button><span class="msg"></span></div></form></details><br><div class="card"><b>الأسئلة (' + faqs.length + ')</b>' +
    faqs.map(f => '<details><summary>' + esc(f.q) + '</summary><form data-form="faq" data-id="' + f.id + '">' + form(f) + '<div class="acts"><button class="btn sm" type="submit">حفظ</button><button type="button" class="btn ghost sm" data-act="faq-del" data-id="' + f.id + '">حذف</button><span class="msg"></span></div></form></details>').join('') + '</div>';
};
DR.outbox = async () => {
  const { outbox } = await api('GET', '/api/admin/outbox');
  return '<div class="card"><b>الصادر إلى البرامج (' + outbox.length + ')</b><p class="muted">كل طالب أُرسل إلى برنامج يظهر هنا؛ علّمه «تم التسليم» بعد إضافته فعليًا في قناة/مجموعة البرنامج.</p>' +
    (outbox.map(o => '<div class="rw" data-id="' + o.id + '"><b>' + esc(o.name) + '</b> ' + genderBadge(o.gender) + ' <span class="muted" dir="ltr">@' + esc(o.username) + '</span> ← ' + esc(o.program_name || o.program_key) + ' <span class="badge ' + (o.status === 'pending' ? 'wait' : 'ok') + '">' + (o.status === 'pending' ? 'بانتظار التسليم' : 'تم التسليم') + '</span> <span class="muted">' + fmtDate(o.created_at) + '</span>' +
      '<div class="acts">' + (o.status === 'pending' ? '<button type="button" class="btn sm" data-act="ob-done">تم التسليم</button>' : '') + '<button type="button" class="btn ghost sm" data-act="ob-del">حذف</button></div></div>').join('') || '<p class="muted">لا يوجد شيء في الصادر.</p>') + '</div>';
};
DR.settings = async () => {
  const { settings } = await api('GET', '/api/admin/settings');
  return '<form class="card" data-form="settings"><b>إعدادات الموقع ونصوصه</b>' + SET_FIELDS.map(f => fld(f[0], f[1], settings[f[0]] || '', { type: f[2] === 'area' ? 'area' : 'text', dir: f[2] === 'url' ? 'ltr' : '' })).join('') +
    '<div class="acts"><button class="btn" type="submit">حفظ الإعدادات</button><span class="msg"></span></div></form>';
};
const viewDash = () => '<section class="dsh"><h3 class="t">لوحة تحكم المشرف</h3><p class="sub">إدارة كاملة لمحتوى الموقع والمستخدمين والمشرفين</p><div class="tabs" id="dtabs"></div><div id="dd"></div></section>';
async function dash() {
  if (tabList().indexOf(DT) < 0) DT = 'overview';
  const tabs = $('#dtabs'), dd = $('#dd');
  if (!tabs || !dd) return;
  tabs.innerHTML = tabList().map(k => '<button type="button" data-act="tab" data-tab="' + k + '"' + (k === DT ? ' class="on"' : '') + '>' + TABS[k] + '</button>').join('');
  try { dd.innerHTML = await DR[DT](); } catch (e) { dd.innerHTML = '<div class="card err">' + esc(e.message) + '</div>'; }
}
async function refreshAll() { await loadSite(); renderChrome(); await dash(); }

/* ───────── معالجات النماذج ───────── */
const lines = t => (t || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf('|'); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });
const FORMS = {
  async login(f, d) {
    setMe(await api('POST', '/api/login', { username: d.username, password: d.password }));
    renderNav(); toast('أهلًا بك ' + S.user.name); location.hash = isStaff() ? '#dashboard' : '#account';
  },
  async signup(f, d) {
    if (!d.name.trim() || !d.username.trim()) throw new Error('أكمل الاسم ومعرّف تيليجرام');
    if (d.password !== d.password2) throw new Error('كلمتا المرور غير متطابقتين');
    if (!d.terms) throw new Error('يلزم الموافقة على شروط الاستخدام وسياسة الخصوصية');
    setMe(await api('POST', '/api/signup', d));
    S.pre = null; renderNav(); toast('تم إنشاء حسابك. سيضيفك المشرف إلى برامجك.'); location.hash = '#account';
  },
  async contact(f, d) {
    await api('POST', '/api/contact', d);
    f.reset(); msg(f, 'وصلت رسالتك، جزاك الله خيرًا. سنردّ عليك قريبًا.');
  },
  async profile(f, d) { setMe(await api('PUT', '/api/me', d)); toast('تم حفظ بياناتك'); route(); },
  async password(f, d) { await api('PUT', '/api/me/password', d); f.reset(); msg(f, 'تم تغيير كلمة المرور'); },
  async sup(f, d) { await api('POST', '/api/admin/supervisors', d); toast('تمت إضافة المشرف'); await dash(); },
  async video(f, d) {
    const id = f.dataset.id; d.published = !!d.published;
    await api(id ? 'PUT' : 'POST', '/api/admin/videos' + (id ? '/' + id : ''), d); toast('تم الحفظ'); await refreshAll();
  },
  async faq(f, d) { const id = f.dataset.id; await api(id ? 'PUT' : 'POST', '/api/admin/faqs' + (id ? '/' + id : ''), d); toast('تم الحفظ'); await refreshAll(); },
  async program(f, d) {
    const key = f.dataset.key;
    d.axes = lines(d.axes); d.plan = lines(d.plan);
    await api(key ? 'PUT' : 'POST', '/api/admin/programs' + (key ? '/' + key : ''), d); toast('تم الحفظ'); await refreshAll();
  },
  async settings(f, d) { await api('PUT', '/api/admin/settings', d); toast('تم حفظ الإعدادات'); await refreshAll(); },
};
function msg(f, t, bad) { const m = $('.msg', f); if (m) { m.textContent = t; m.className = 'msg' + (bad ? ' err' : ''); } else if (t) toast(t, bad); }

document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const b = $('button[type=submit]', f);
  if (b) b.disabled = true;
  msg(f, '');
  try { await FORMS[f.dataset.form](f, readForm(f)); } catch (err) { msg(f, err.message, true); }
  if (b) b.disabled = false;
});

/* ───────── الإجراءات (أزرار) ───────── */
const rowId = el => (el.closest('[data-id]') || el).dataset.id;
const rowProgs = el => $$('input[data-p]:checked', el.closest('.rw')).map(i => i.value);
async function relogin() { setMe({}); renderNav(); location.hash = '#login'; }
const ACT = {
  menu() { $('#nav').classList.toggle('open'); },
  'profile-toggle'() {
    const menu = $('#profile-dropdown');
    const expanded = menu.hidden;
    menu.hidden = !expanded;
    $('#profile-toggle').setAttribute('aria-expanded', String(expanded));
  },
  close() { closeVideo(); },
  'close-go'(el) { closeVideo(); if (el.dataset.tab) DT = el.dataset.tab; if (el.getAttribute('href') === '#dashboard' && location.hash === '#dashboard') route(); else if (el.getAttribute('href')) location.hash = el.getAttribute('href'); },
  async logout() { await api('POST', '/api/logout'); setMe({}); renderNav(); toast('تم تسجيل الخروج'); location.hash = '#home'; route(); },
  async enroll(el) { setMe(await api('POST', '/api/enroll', { program: el.dataset.key })); toast('تم إرسال طلب الانضمام للمشرف'); route(); },
  async unenroll(el) { setMe(await api('DELETE', '/api/enroll/' + el.dataset.key)); toast('أُلغي الطلب'); route(); },
  async 'toggle-save'(el) {
    const id = Number(el.dataset.id), saved = S.saved.indexOf(id) > -1;
    setMe(await api(saved ? 'DELETE' : 'POST', '/api/saved/' + id)); renderModalFoot(vid(id)); toast(saved ? 'أُزيل من دروسك المحفوظة' : 'حُفظ في دروسك');
    if (S.route === 'account') route();
  },
  lfilter(el) { LF.p = el.dataset.p; $('#lchips').innerHTML = chips(); $('#lgrid').innerHTML = lessonsGrid(); },
  tab(el) { DT = el.dataset.tab; dash(); },
  async 'st-save'(el) { await api('PUT', '/api/admin/students/' + rowId(el) + '/programs', { programs: rowProgs(el) }); toast('تم حفظ البرامج'); await dash(); },
  async 'st-send'(el) {
    await api('PUT', '/api/admin/students/' + rowId(el) + '/programs', { programs: rowProgs(el) });
    const r = await api('POST', '/api/admin/students/' + rowId(el) + '/send'); toast('أُرسل إلى: ' + r.sent.map(pname).join('، ')); await dash();
  },
  async 'sup-save'(el) { await api('PUT', '/api/admin/supervisors/' + rowId(el) + '/programs', { programs: rowProgs(el) }); toast('تم الحفظ'); await dash(); },
  async 'u-del'(el) { if (!confirm('حذف هذا الحساب نهائيًا مع كل بياناته؟')) return; await api('DELETE', '/api/admin/users/' + rowId(el)); toast('تم الحذف'); await dash(); },
  async 'u-pass'(el) { const p = prompt('كلمة المرور الجديدة (٨ أحرف على الأقل):'); if (!p) return; await api('PUT', '/api/admin/users/' + rowId(el) + '/password', { password: p }); toast('تم تغيير كلمة المرور'); },
  async 'msg-read'(el) { await api('PUT', '/api/admin/messages/' + rowId(el), { read: true }); await dash(); },
  async 'msg-del'(el) { if (!confirm('حذف الرسالة؟')) return; await api('DELETE', '/api/admin/messages/' + rowId(el)); await dash(); },
  async 'vid-del'(el) { if (!confirm('حذف هذا الدرس؟')) return; await api('DELETE', '/api/admin/videos/' + el.dataset.id); toast('تم الحذف'); await refreshAll(); },
  async 'faq-del'(el) { if (!confirm('حذف السؤال؟')) return; await api('DELETE', '/api/admin/faqs/' + el.dataset.id); toast('تم الحذف'); await refreshAll(); },
  async 'prog-del'(el) { if (!confirm('حذف البرنامج؟ سيُحذف تسجيل الطلاب فيه.')) return; await api('DELETE', '/api/admin/programs/' + el.dataset.key); toast('تم الحذف'); await refreshAll(); },
  async 'ob-done'(el) { await api('PUT', '/api/admin/outbox/' + rowId(el)); await dash(); },
  async 'ob-del'(el) { await api('DELETE', '/api/admin/outbox/' + rowId(el)); await dash(); },
};
document.addEventListener('click', async e => {
  if (e.target === $('#modal')) { closeVideo(); return; }
  if (!e.target.closest('#account-menu')) {
    $('#profile-dropdown').hidden = true;
    $('#profile-toggle').setAttribute('aria-expanded', 'false');
  }
  const el = e.target.closest('[data-act],[data-play]');
  if (!el) return;
  if (el.dataset.play) { e.preventDefault(); openVideo(el.dataset.play); return; }
  const a = el.dataset.act;
  if (a === 'pre') { S.pre = el.dataset.key; return; }
  if (!ACT[a]) return;
  e.preventDefault();
  if (el.tagName === 'BUTTON') el.disabled = true;
  try { await ACT[a](el); } catch (err) {
    if (err.status === 401 && S.user) { toast('انتهت الجلسة، سجّل الدخول من جديد', true); await relogin(); } else toast(err.message, true);
  }
  if (el.isConnected && el.tagName === 'BUTTON') el.disabled = false;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeVideo();
    $('#profile-dropdown').hidden = true;
    $('#profile-toggle').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'lsearch') { LF.q = e.target.value; $('#lgrid').innerHTML = lessonsGrid(); }
  if (e.target.id === 'stsearch') { const q = e.target.value.trim().toLowerCase(); $$('.rw[data-q]').forEach(r => { r.hidden = q && r.dataset.q.indexOf(q) < 0; }); }
});
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[type=file][data-upload]') || !inp.files[0]) return;
  const file = inp.files[0];
  try {
    const r = await fetch('/api/admin/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'فشل الرفع');
    const t = inp.parentNode.querySelector('input[name="' + inp.dataset.upload + '"]');
    if (t) t.value = d.path;
    toast('تم رفع الصورة — اضغط حفظ لتثبيتها');
  } catch (err) { toast(err.message, true); }
});

/* ───────── الهيكل والتوجيه ───────── */
function renderNav() {
  const cur = S.route === 'programs' ? 'home' : S.route;
  const items = [['home', 'الرئيسية']].concat(S.site.programs.map(p => [p.key, p.name]), [['lessons', 'الدروس'], ['contact', 'تواصل معنا']]);
  if (!S.user) items.push(['login', 'تسجيل الدخول']);
  else { items.push(['account', 'حسابي']); if (isStaff()) items.push(['dashboard', 'لوحة التحكم']); }
  let h = items.map(x => '<a href="#' + esc(x[0]) + '" class="' + (x[0] === cur ? 'on' : '') + '">' + esc(x[1]) + '</a>').join('');
  h += '<a class="nav-sheikh" href="' + esc(safeUrl(cfg('tg_sheikh'))) + '" target="_blank" rel="noopener">قناة الشيخ حسين</a>';
  $('#nav').innerHTML = h; $('#nav').classList.remove('open');
  const accountMenu = $('#account-menu');
  const profileToggle = $('#profile-toggle');
  if (S.user) {
    accountMenu.hidden = false;
    $('#header-avatar').className = 'gender-avatar ' + genderClass(S.user.gender);
    $('#header-avatar').innerHTML = genderIcon(S.user.gender);
    $('#header-name').textContent = S.user.name;
    $('#profile-dropdown').hidden = true;
    profileToggle.setAttribute('aria-expanded', 'false');
  } else {
    accountMenu.hidden = true;
  }
}
function renderChrome() {
  $('#lg').src = '/img/sheikh.jpg';
  $('#brand').textContent = cfg('site_name'); $('#sheikh').textContent = cfg('sheikh_name');
  $('#tgbtn').href = safeUrl(cfg('tg_sheikh'));
  $('#tgbtn').textContent = 'قناة الشيخ حسين';
  const link = (h, t) => '<a href="' + esc(h) + '" target="_blank" rel="noopener">' + esc(t) + '</a>';
  $('#foot').innerHTML = '<div><div><b>' + esc(cfg('site_name')) + '</b>' + esc(cfg('footer_about')) + '</div>' +
    '<div><b>البرامج</b>' + S.site.programs.map(p => '<a href="#' + esc(p.key) + '">برنامج ' + esc(p.name) + '</a>').join('') + '</div>' +
    '<div><b>تابعونا</b>' + link(safeUrl(cfg('yt_channel')), 'قناة يوتيوب') + link(safeUrl(cfg('tg_sheikh')), 'قناة الشيخ') + link(safeUrl(cfg('tg_institute')), 'قناة المعهد') + '<a href="#terms">الشروط والخصوصية</a></div></div>' +
    '<p class="copy">' + esc(cfg('copyright')) + '</p>';
  renderNav();
}
function resolve() {
  let r = (location.hash || '#home').slice(1);
  if (PAGES.indexOf(r) < 0 && !prog(r)) r = 'home';
  if (r === 'account' && !S.user) r = 'login';
  if (r === 'dashboard' && !isStaff()) r = S.user ? 'account' : 'login';
  if ((r === 'login' || r === 'signup') && S.user) r = 'account';
  return r;
}
function route() {
  const r = resolve();
  S.route = r;
  const p = prog(r);
  const titles = { home: '', programs: 'البرامج', lessons: 'الدروس', contact: 'تواصل معنا', login: 'تسجيل الدخول', signup: 'إنشاء حساب', account: 'حسابي', dashboard: 'لوحة التحكم', terms: 'الشروط والخصوصية' };
  const t = p ? 'برنامج ' + p.name : titles[r];
  document.title = (t ? t + ' — ' : '') + cfg('site_name');
  const views = { home: viewHome, programs: viewHome, lessons: viewLessons, contact: viewContact, login: viewLogin, signup: viewSignup, account: viewAccount, dashboard: viewDash, terms: viewTerms };
  $('#app').innerHTML = p ? viewProgram(p) : views[r]();
  renderNav();
  if (r === 'dashboard') dash();
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (r === 'programs') {
    const target = $('#programs');
    if (target) target.scrollIntoView({ behavior, block: 'start' });
  } else window.scrollTo({ top: 0, behavior });
}
addEventListener('hashchange', () => { closeVideo(); route(); });

(async function init() {
  initTheme();
  try {
    await loadSite();
    try { await loadMe(); } catch (e) { setMe({}); }
    renderChrome(); route();
  } catch (e) {
    $('#app').innerHTML = '<section><p class="sub err">تعذّر تحميل الموقع: ' + esc(e.message) + '</p></section>';
  }
})();
})();
