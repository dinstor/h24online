// ════════════════════════════════════════════════════════
// AUTH PERSISTENCE FIX — app.js এর onMounted এ এই অংশ যোগ করুন
// ════════════════════════════════════════════════════════
//
// সমস্যা: পেজ রিলোড বা নেভিগেশনে auth state হারিয়ে যাচ্ছে।
// সমাধান: setPersistence(browserLocalPersistence) সবার আগে call করতে হবে
//         এবং onAuthStateChanged দিয়ে redirect handle করতে হবে।
//
// আপনার বিদ্যমান app.js এর onMounted() এর শুরুতে নিচের কোড যোগ করুন:
//
//   await setPersistence(auth, browserLocalPersistence).catch(() => {});
//
// এবং onAuthStateChanged এর ভেতরে নিচের মতো করুন:

/*
onAuthStateChanged(auth, async (user) => {
  if (user) {
    isLoggedIn.value = true;

    // ── LocalStorage sync ──
    localStorage.setItem('userId', user.uid);

    // ── Online status update ──
    const markOnline = () =>
      updateDoc(doc(db, 'users', user.uid), {
        isOnline: true,
        lastSeen: serverTimestamp()
      }).catch(() => {});
    markOnline();
    setInterval(markOnline, 60000);

    const markOffline = () =>
      updateDoc(doc(db, 'users', user.uid), {
        isOnline: false,
        lastSeen: serverTimestamp()
      }).catch(() => {});
    window.addEventListener('beforeunload', markOffline);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) markOffline();
      else markOnline();
    });

    // ── Real-time balance ──
    onSnapshot(doc(db, 'users', user.uid), (d) => {
      if (d.exists()) {
        userBalance.value = d.data().balance || 0;
        userAvatar.value = d.data().photoURL || 'https://i.pravatar.cc/150?img=12';
        userData.value = d.data();
        const uid = user.uid.replace(/\D/g, '');
        supportPin.value = uid.length > 5
          ? uid.substring(0, 6)
          : Math.floor(100000 + Math.random() * 900000);
      }
    });

    checkTodayCheckin(user.uid);
    fetchTurnovers();

  } else {
    // ── শুধুমাত্র login/register পেজে না থাকলে redirect করুন ──
    isLoggedIn.value = false;
    userBalance.value = 0;
    userData.value = {};
    // NOTE: index.html এ থাকলে login পেজে পাঠান
    // কিন্তু এই কোড index.html এই চলে, তাই:
    // page.value = 'login'; // এই লাইনটি রাখলেই হবে
  }
});
*/

// ════════════════════════════════════════════════════════
// COMPLETE FIXED app.js
// ════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile,
  browserLocalPersistence, setPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, query, where,
  addDoc, updateDoc, increment, runTransaction, serverTimestamp,
  onSnapshot, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  createApp, ref, computed, onMounted, nextTick, watch
} from "https://unpkg.com/vue@3/dist/vue.esm-browser.js";

const EPS_PAYMENT_URL = "https://pg.eps.com.bd/PaymentLink?id=D37C6FF8";
const APP_BASE_URL = window.location.origin + window.location.pathname;
const CURRENT_APP_VERSION = "1.0.6";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/h24-online/databases/(default)/documents`;

// ══════════════════════════════════════════
// CACHE SYSTEM
// ══════════════════════════════════════════
const _memCache = {};
const CACHE_TTL = 5 * 60 * 1000;

const mem = {
  get(key) {
    const e = _memCache[key];
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL) { delete _memCache[key]; return null; }
    return e.data;
  },
  set(key, data) { _memCache[key] = { data, ts: Date.now() }; },
  del(key) { delete _memCache[key]; }
};

const sess = {
  get(key) {
    try { const r = sessionStorage.getItem('h24_' + key); return r ? JSON.parse(r) : null; }
    catch { return null; }
  },
  set(key, data) { try { sessionStorage.setItem('h24_' + key, JSON.stringify(data)); } catch {} },
  del(key) { try { sessionStorage.removeItem('h24_' + key); } catch {} }
};

const smartGet = async (docRef, key) => {
  const m = mem.get(key); if (m) return m;
  const s = sess.get(key); if (s) { mem.set(key, s); return s; }
  const snap = await getDoc(docRef);
  if (snap.exists()) { const d = snap.data(); mem.set(key, d); sess.set(key, d); return d; }
  return null;
};

// ══════════════════════════════════════════
// PAYMENT CONFIG
// ══════════════════════════════════════════
let PAYMENT_SCRIPT_URL = null, PAYMENT_CLIENT_KEY = null, PAYMENT_CONFIG_READY = false;

const loadPaymentConfig = async () => {
  const cached = mem.get('paymentConfig') || sess.get('paymentConfig');
  if (cached) {
    PAYMENT_SCRIPT_URL = cached.script_url;
    PAYMENT_CLIENT_KEY = cached.api_key;
    PAYMENT_CONFIG_READY = !!PAYMENT_SCRIPT_URL;
    return;
  }
  try {
    const res = await fetch(`${FIRESTORE_REST_BASE}/AppConfig/payment_config`);
    if (res.ok) {
      const data = await res.json();
      const fields = data.fields || {};
      PAYMENT_SCRIPT_URL = fields.script_url?.stringValue || null;
      PAYMENT_CLIENT_KEY = fields.api_key?.stringValue || null;
      if (PAYMENT_SCRIPT_URL) {
        PAYMENT_CONFIG_READY = true;
        const cfg = { script_url: PAYMENT_SCRIPT_URL, api_key: PAYMENT_CLIENT_KEY };
        mem.set('paymentConfig', cfg); sess.set('paymentConfig', cfg);
      }
    }
  } catch (e) {}
};
loadPaymentConfig();

// ══════════════════════════════════════════
// FIREBASE INIT
// ══════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyCZWRcCP0hXTkfQoRhqxczgdD6cw5kp39c",
  authDomain: "h24-online.firebaseapp.com",
  databaseURL: "https://h24-online-default-rtdb.firebaseio.com",
  projectId: "h24-online",
  storageBucket: "h24-online.firebasestorage.app",
  messagingSenderId: "808524719613",
  appId: "1:808524719613:web:7f1abe9e70a346c3376594"
};
const fireApp = initializeApp(firebaseConfig);
const auth = getAuth(fireApp);

// ✅ FIX: Persistence সেট করুন অ্যাপ শুরুতেই
await setPersistence(auth, browserLocalPersistence).catch(() => {});

const db = getFirestore(fireApp);

// ══════════════════════════════════════════
// VUE APP
// ══════════════════════════════════════════
createApp({
  setup() {
    const page = ref('home');
    const isLoggedIn = ref(false);
    const userBalance = ref(0);
    const userAvatar = ref('https://i.pravatar.cc/150?img=12');
    const userData = ref({});
    const noticeMessage = ref('আমাদের H24 Online স্টোরে আপনাকে স্বাগতম! সেরা দামে গেম টপআপ করুন।');
    const logoUrl = ref('');
    const banners = ref([]);
    const mysteryBoxes = ref([]);
    const specialOffers = ref([]);
    const gameItems = ref([]);
    const otherItems = ref([]);
    const socials = ref({});
    const liveUrl = ref('');
    const liveLoading = ref(false);
    const adminNumbers = ref({ bkash: '', nagad: '', rocket: '' });
    const supportPin = ref('---');
    const stats = ref({ totalSpent: 0, totalOrders: 0, weeklySpent: 0 });
    const minWithdraw = ref(500);
    const depositQuickAmounts = ref([100, 300, 500, 1000]);
    const withdrawQuickAmounts = ref([500, 1000, 1500, 2000]);
    const rounds = ref([]);
    const sheetOptions = ref([]);
    const navHidden = ref(false);

    // Session cache preload
    const preloadFromCache = () => {
      const n = sess.get('settings_notice'); if (n) noticeMessage.value = n.text || noticeMessage.value;
      const a = sess.get('settings_announcement'); if (a) announcementLines.value = a.lines || [];
      const l = sess.get('settings_logo'); if (l) logoUrl.value = l.url || '';
      const p = sess.get('settings_payment'); if (p) adminNumbers.value = p;
      const s = sess.get('admin_settings'); if (s) socials.value = s;
      const r = sess.get('settings_rounds'); if (r?.list) rounds.value = r.list;
      const sh = sess.get('settings_sheetInfo'); if (sh?.list) sheetOptions.value = sh.list;
      const amt = sess.get('settings_amounts');
      if (amt) {
        if (amt.depositAmounts?.length) depositQuickAmounts.value = amt.depositAmounts;
        if (amt.withdrawAmounts?.length) withdrawQuickAmounts.value = amt.withdrawAmounts;
        if (amt.minWithdraw) minWithdraw.value = Number(amt.minWithdraw);
      }
      const prods = sess.get('products_cache');
      if (prods) {
        mysteryBoxes.value = []; specialOffers.value = []; gameItems.value = []; otherItems.value = [];
        prods.forEach(item => {
          const cat = item.category;
          if (cat === 'mystery') mysteryBoxes.value.push(item);
          else if (cat === 'special') specialOffers.value.push(item);
          else if (cat === 'freefire' || cat === 'ingame') gameItems.value.push(item);
          else if (cat === 'shell' || cat === 'giftcard' || cat === 'subscription') otherItems.value.push(item);
          else gameItems.value.push(item);
        });
      }
      const bn = sess.get('banners_cache'); if (bn) banners.value = bn;
    };

    // PTR
    const ptrVisible = ref(false);
    const ptrLoading = ref(false);
    let ptrStartY = 0, ptrTriggered = false;
    const ptrTouchStart = (e) => {
      const el = document.getElementById('accountScroll');
      if (el && el.scrollTop <= 0) { ptrStartY = e.touches[0].clientY; ptrTriggered = false; }
      else ptrStartY = 0;
    };
    const ptrTouchMove = (e) => {
      if (!ptrStartY) return;
      if (e.touches[0].clientY - ptrStartY > 60 && !ptrTriggered) { ptrVisible.value = true; ptrTriggered = true; }
    };
    const ptrTouchEnd = async () => {
      if (!ptrTriggered) return;
      ptrLoading.value = true;
      ['settings_notice','settings_announcement','settings_logo','settings_payment','admin_settings'].forEach(k => {
        mem.del(k); sess.del(k);
      });
      try {
        const user = auth.currentUser;
        if (user) { await fetchStats(); await fetchTurnovers(); await fetchReferralStats(); await checkTodayCheckin(user.uid); }
      } catch(e) {}
      ptrLoading.value = false; ptrVisible.value = false; ptrTriggered = false; ptrStartY = 0;
      showToast('✅ Refreshed!');
    };

    // Turnover
    const turnoverModal = ref(false);
    const turnoverTab = ref('active');
    const turnoverLoading = ref(false);
    const activeTurnovers = ref([]);
    const completedTurnovers = ref([]);
    const _turnoversLoaded = ref(false);

    const fetchTurnovers = async () => {
      const uid = localStorage.getItem('userId');
      if (!uid) return;
      turnoverLoading.value = true;
      activeTurnovers.value = []; completedTurnovers.value = [];
      try {
        const snap = await getDocs(query(collection(db, 'turnovers'), where('userId', '==', uid)));
        snap.forEach(d => {
          const item = { id: d.id, ...d.data() };
          if (d.data().status === 'completed') completedTurnovers.value.push(item);
          else activeTurnovers.value.push(item);
        });
        _turnoversLoaded.value = true;
      } catch (e) {}
      finally { turnoverLoading.value = false; }
    };
    const openTurnoverModal = () => { turnoverTab.value = 'active'; turnoverModal.value = true; };

    // Announcement
    const announcementLines = ref([]);
    const announcementModal = ref(false);
    const showAnnouncement = () => { announcementModal.value = true; };

    // Check-In
    const checkInClaimed = ref(false);
    const claimDailyBonus = async () => {
      if (!isLoggedIn.value) { navigateTo('login'); return; }
      if (checkInClaimed.value) return;
      const user = auth.currentUser;
      if (!user) { navigateTo('login'); return; }
      const uid = user.uid;
      const today = new Date().toISOString().slice(0, 10);
      const checkinRef = doc(db, 'checkins', `${uid}_${today}`);
      try {
        const snap = await getDoc(checkinRef);
        if (snap.exists()) {
          checkInClaimed.value = true;
          showPopup('error', 'Already Claimed', 'আজকের বোনাস আগেই নেওয়া হয়েছে। কাল আবার আসুন!');
          return;
        }
        await setDoc(checkinRef, { userId: uid, date: today, amount: 10, claimedAt: serverTimestamp() });
        await updateDoc(doc(db, 'users', uid), { balance: increment(10) });
        await addDoc(collection(db, 'balanceLogs'), { userId: uid, type: 'daily_bonus', amount: 10, note: 'Daily Check-In', createdAt: serverTimestamp() });
        await addDoc(collection(db, 'turnovers'), { userId: uid, type: 'daily_bonus', label: 'Daily Bonus Turnover (৳10)', required: 10, done: 0, status: 'active', createdAt: serverTimestamp() });
        await fetchTurnovers();
        checkInClaimed.value = true;
        showPopup('success', 'বোনাস পেয়েছেন! 🎉', '৳১০ আপনার ওয়ালেটে যোগ হয়েছে।');
      } catch (e) { showPopup('error', 'Error', 'কিছু সমস্যা হয়েছে।'); }
    };
    const checkTodayCheckin = async (uid) => {
      const today = new Date().toISOString().slice(0, 10);
      try {
        const snap = await getDoc(doc(db, 'checkins', `${uid}_${today}`));
        checkInClaimed.value = snap.exists();
      } catch (e) {}
    };

    // Rounds
    const loadRounds = async () => {
      if (rounds.value.length > 0) return;
      try {
        const data = await smartGet(doc(db, 'settings', 'rounds'), 'settings_rounds');
        if (data?.list) rounds.value = data.list;
        const sheetData = await smartGet(doc(db, 'settings', 'sheetInfo'), 'settings_sheetInfo');
        if (sheetData?.list) sheetOptions.value = sheetData.list;
      } catch (e) {}
    };

    // Referral
    const referralStats = ref({ totalRefs: 0, totalEarned: 0 });
    const referralLink = computed(() => {
      const uid = localStorage.getItem('userId') || '';
      return `${APP_BASE_URL}?ref=${uid.substring(0, 8)}`;
    });
    const copyReferralLink = () => { navigator.clipboard.writeText(referralLink.value); showToast('✅ লিংক কপি হয়েছে!'); };
    const shareReferral = async () => {
      if (navigator.share) {
        try { await navigator.share({ title: 'H24 Online', text: 'H24 Online-এ যোগ দিন!', url: referralLink.value }); }
        catch (e) {}
      } else copyReferralLink();
    };
    const fetchReferralStats = async () => {
      const uid = localStorage.getItem('userId');
      if (!uid) return;
      try {
        const cached = mem.get('referralStats_' + uid);
        if (cached) { referralStats.value = cached; return; }
        const snap = await getDoc(doc(db, 'referrals', uid));
        if (snap.exists()) {
          const d = { totalRefs: snap.data().totalRefs || 0, totalEarned: snap.data().totalEarned || 0 };
          referralStats.value = d; mem.set('referralStats_' + uid, d);
        }
      } catch (e) {}
    };

    const openSocialLink = (url) => {
      if (!url) return '#';
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      if (url.startsWith('whatsapp://')) { const m = url.match(/phone=(\d+)/); return m ? `https://wa.me/${m[1]}` : 'https://wa.me'; }
      if (url.startsWith('tg://')) return url.replace('tg://resolve?domain=', 'https://t.me/');
      return 'https://' + url;
    };

    // Popup
    const popup = ref({ show: false, type: '', title: '', msg: '', btnText: 'OK', confirm: null });
    const showPopup = (type, title, msg, btnText = 'OK', confirm = null) => {
      popup.value = { show: true, type, title, msg, btnText, confirm };
    };
    const closePopup = () => {
      if (popup.value.btnText === 'Deposit') { popup.value.show = false; navigateTo('add-money'); }
      else if (popup.value.btnText === 'Orders') { popup.value.show = false; navigateTo('orders'); }
      else if (popup.value.btnText === 'Balance History') { popup.value.show = false; navigateTo('balance-history'); }
      else popup.value.show = false;
    };

    // App Version
    const updateModal = ref({ show: false, newVersion: '', message: '', changelog: [], updateUrl: '', forceUpdate: false });
    const checkAppVersion = async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'appVersion'));
        if (!snap.exists()) return;
        const data = snap.data();
        const latestVersion = data.version || '';
        if (!latestVersion || latestVersion === CURRENT_APP_VERSION) return;
        const parseV = (v) => v.split('.').map(Number);
        const latest = parseV(latestVersion), current = parseV(CURRENT_APP_VERSION);
        let needsUpdate = false;
        for (let i = 0; i < Math.max(latest.length, current.length); i++) {
          const l = latest[i] || 0, c = current[i] || 0;
          if (l > c) { needsUpdate = true; break; } if (l < c) break;
        }
        if (!needsUpdate) return;
        updateModal.value = {
          show: true, newVersion: latestVersion, message: data.message || 'নতুন আপডেট!',
          changelog: data.changelog || [], updateUrl: data.updateUrl || '', forceUpdate: data.forceUpdate || false
        };
      } catch (e) {}
    };

    // Withdraw
    const withdrawModal = ref({ show: false, amount: '', gateway: 'bkash', accountNumber: '', loading: false, error: '' });
    const openWithdrawModal = () => {
      if (!isLoggedIn.value) { navigateTo('login'); return; }
      withdrawModal.value = { show: true, amount: '', gateway: 'bkash', accountNumber: userData.value.phone || '', loading: false, error: '' };
    };
    const submitWithdraw = async () => {
      const wm = withdrawModal.value;
      wm.error = '';
      const minAmt = minWithdraw.value || 500;
      if (!wm.amount || Number(wm.amount) < minAmt) { wm.error = `সর্বনিম্ন ৳${minAmt} উইথড্র করুন।`; return; }
      if (Number(wm.amount) > userBalance.value) { wm.error = 'আপনার ব্যালেন্স পর্যাপ্ত নয়।'; return; }
      if (!wm.accountNumber || wm.accountNumber.length < 10) { wm.error = 'সঠিক নম্বর দিন (১০ ডিজিট)।'; return; }
      if (activeTurnovers.value.length > 0) { wm.error = '⚠️ Turnover Complete হয়নি।'; return; }
      wm.loading = true;
      try {
        const uid = localStorage.getItem('userId');
        const pendingSnap = await getDocs(query(collection(db, 'withdrawals'), where('userId', '==', uid), where('status', '==', 'pending')));
        if (!pendingSnap.empty) { wm.error = 'একটি উইথড্র রিকোয়েস্ট পেন্ডিং।'; wm.loading = false; return; }
        const amount = Number(wm.amount);
        await runTransaction(db, async (t) => {
          const uRef = doc(db, 'users', uid);
          const uDoc = await t.get(uRef);
          if (uDoc.data().balance < amount) throw new Error('Low Balance');
          t.update(uRef, { balance: uDoc.data().balance - amount });
          t.set(doc(collection(db, 'withdrawals')), { userId: uid, amount, gateway: wm.gateway, accountNumber: wm.accountNumber, status: 'pending', createdAt: serverTimestamp() });
        });
        withdrawModal.value.show = false;
        showPopup('success', '✅ রিকোয়েস্ট সফল!', `৳${amount} উইথড্র রিকোয়েস্ট পাঠানো হয়েছে।`, 'Balance History');
      } catch (e) {
        if (e.message === 'Low Balance') wm.error = 'ব্যালেন্স পর্যাপ্ত নয়।';
        else { showPopup('error', '❌ সমস্যা হয়েছে', 'উইথড্র রিকোয়েস্ট পাঠানো যায়নি।'); withdrawModal.value.show = false; }
      } finally { wm.loading = false; }
    };

    // Auth refs (index.html এর login/register page এর জন্য)
    const loginEmail = ref(''), loginPass = ref(''), loginLoading = ref(false);
    const regName = ref(''), regPhone = ref(''), regEmail = ref('');
    const regPass = ref(''), regConfirm = ref(''), regLoading = ref(false);
    const regReferralCode = ref('');
    const urlRef = new URLSearchParams(window.location.search).get('ref');
    if (urlRef) regReferralCode.value = urlRef;

    const handleGoogleLogin = async () => {
      try {
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        if (!snap.exists()) {
          await setDoc(userRef, {
            uid: user.uid, name: user.displayName || 'User', email: user.email,
            photoURL: user.photoURL || '', balance: 0, phone: '',
            referralCode: user.uid.substring(0, 8), joinedAt: new Date().toISOString()
          });
        }
        await updateDoc(doc(db, 'users', user.uid), { lastSeen: serverTimestamp(), isOnline: true }).catch(() => {});
        localStorage.setItem('userId', user.uid);
        navigateTo('home');
      } catch (e) { alert('Google login failed: ' + e.message); }
    };

    const handleEmailLogin = async () => {
      if (!loginEmail.value || !loginPass.value) return;
      loginLoading.value = true;
      try {
        const result = await signInWithEmailAndPassword(auth, loginEmail.value, loginPass.value);
        await updateDoc(doc(db, 'users', result.user.uid), { lastSeen: serverTimestamp(), isOnline: true }).catch(() => {});
        localStorage.setItem('userId', result.user.uid);
        navigateTo('home');
      } catch (e) { alert('Invalid email or password!'); }
      finally { loginLoading.value = false; }
    };

    const handleRegister = async () => {
      if (regPass.value !== regConfirm.value || regPass.value.length < 6) return;
      regLoading.value = true;
      try {
        // Phone duplicate check
        if (regPhone.value) {
          const phoneQ = query(collection(db, 'users'), where('phone', '==', regPhone.value.trim()));
          const phoneSnap = await getDocs(phoneQ);
          if (!phoneSnap.empty) { alert('এই ফোন নম্বর দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে।'); regLoading.value = false; return; }
        }
        const result = await createUserWithEmailAndPassword(auth, regEmail.value, regPass.value);
        await updateProfile(result.user, { displayName: regName.value });
        const uid = result.user.uid;
        await setDoc(doc(db, 'users', uid), {
          uid, name: regName.value, email: regEmail.value, phone: regPhone.value,
          balance: 0, photoURL: '', referralCode: uid.substring(0, 8),
          referredBy: regReferralCode.value || '', joinedAt: new Date().toISOString(),
          lastSeen: serverTimestamp(), isOnline: true
        });
        if (regReferralCode.value) {
          try {
            const refSnap = await getDocs(query(collection(db, 'users'), where('referralCode', '==', regReferralCode.value)));
            if (!refSnap.empty) {
              const referrerId = refSnap.docs[0].id;
              const refDocRef = doc(db, 'referrals', referrerId);
              const refDoc = await getDoc(refDocRef);
              if (refDoc.exists()) await updateDoc(refDocRef, { totalRefs: increment(1) });
              else await setDoc(refDocRef, { totalRefs: 1, totalEarned: 0 });
            }
          } catch (re) {}
        }
        localStorage.setItem('userId', uid);
        navigateTo('home');
      } catch (e) {
        alert(e.code === 'auth/email-already-in-use' ? 'Email already in use!' : 'Registration failed!');
      } finally { regLoading.value = false; }
    };

    // ✅ FIX: সঠিক লগআউট
    const handleLogout = async () => {
      if (confirm('আপনি কি নিশ্চিত লগআউট করতে চান?')) {
        if (chatUnsubscribe.value) chatUnsubscribe.value();
        const uid = localStorage.getItem('userId');
        if (uid) {
          await updateDoc(doc(db, 'users', uid), { isOnline: false, lastSeen: serverTimestamp() }).catch(() => {});
        }
        try { await signOut(auth); } catch (e) {}
        localStorage.removeItem('userId');
        sessionStorage.clear();
        isLoggedIn.value = false;
        userBalance.value = 0;
        userData.value = {};
        navigateTo('login');
      }
    };

    const goProtected = (p) => { isLoggedIn.value ? navigateTo(p) : navigateTo('login'); };

    // Banner
    const handleBannerClick = (banner) => {
      if (!banner) return;
      if (banner.productId) {
        const all = [...mysteryBoxes.value, ...specialOffers.value, ...gameItems.value, ...otherItems.value];
        const p = all.find(x => x.id === banner.productId);
        if (p) { openPurchase(p); return; }
      }
      if (banner.link) window.open(openSocialLink(banner.link), '_blank');
    };

    // Purchase Modal
    const purchaseModal = ref({
      show: false, product: {}, packages: [], selectedPkg: null,
      playerId: '', selectedRound: '', payMethod: 'wallet',
      gateway: 'bkash', trxId: '', epsRef: '', verifying: false
    });
    const openPurchase = (item) => {
      if (!isLoggedIn.value) { navigateTo('login'); return; }
      purchaseModal.value = {
        show: true, product: item,
        packages: item.packages?.length > 0 ? item.packages : [{ name: 'Default', price: item.price || 0 }],
        selectedPkg: null, playerId: '', selectedRound: '',
        payMethod: 'wallet', gateway: 'bkash', trxId: '', epsRef: '', verifying: false
      };
    };
    const handleEpsPurchaseRedirect = () => {
      if (!purchaseModal.value.selectedPkg) { showPopup('error', 'Select Package', 'Please choose a package first.'); return; }
      window.open(EPS_PAYMENT_URL, '_blank');
    };

    // Turnover Progress
    const updateTurnoverProgress = async (uid, spentAmount) => {
      try {
        const snap = await getDocs(query(collection(db, 'turnovers'), where('userId', '==', uid), where('status', '==', 'active')));
        let remaining = spentAmount;
        for (const d of snap.docs) {
          if (remaining <= 0) break;
          const data = d.data(), needed = data.required - (data.done || 0);
          if (needed <= 0) { await updateDoc(doc(db, 'turnovers', d.id), { status: 'completed', done: data.required }); continue; }
          const toAdd = Math.min(remaining, needed), newDone = (data.done || 0) + toAdd;
          if (newDone >= data.required) await updateDoc(doc(db, 'turnovers', d.id), { done: data.required, status: 'completed' });
          else await updateDoc(doc(db, 'turnovers', d.id), { done: newDone });
          remaining -= toAdd;
        }
        await fetchTurnovers();
      } catch (e) {}
    };

    // Referral Commission
    const addReferralCommission = async (buyerUid, orderPrice) => {
      try {
        const buyerSnap = await getDoc(doc(db, 'users', buyerUid));
        if (!buyerSnap.exists()) return;
        const referredBy = buyerSnap.data().referredBy;
        if (!referredBy) return;
        const refSnap = await getDocs(query(collection(db, 'users'), where('referralCode', '==', referredBy)));
        if (refSnap.empty) return;
        const referrerId = refSnap.docs[0].id;
        const commission = Math.floor(orderPrice * 0.10);
        if (commission <= 0) return;
        await updateDoc(doc(db, 'users', referrerId), { balance: increment(commission) });
        const refDocRef = doc(db, 'referrals', referrerId);
        const refDoc = await getDoc(refDocRef);
        if (refDoc.exists()) await updateDoc(refDocRef, { totalEarned: increment(commission) });
        else await setDoc(refDocRef, { totalRefs: 0, totalEarned: commission });
        await addDoc(collection(db, 'balanceLogs'), { userId: referrerId, type: 'referral', amount: commission, note: 'Refer Bonus', createdAt: serverTimestamp() });
        mem.del('referralStats_' + referrerId);
      } catch (e) {}
    };

    const handlePurchaseBuy = async () => {
      const pm = purchaseModal.value;
      if (!pm.selectedPkg) return showPopup('error', 'Select Package', 'Please choose a package.');
      if (!pm.playerId) return showPopup('error', 'Missing Info', 'Sheet No দিন।');
      if (!pm.selectedRound) return showPopup('error', 'Select Round', 'Round select করুন।');
      const uid = localStorage.getItem('userId');
      const orderData = {
        userId: uid, packageName: pm.selectedPkg.name, price: pm.selectedPkg.price,
        playerId: pm.playerId, sheetInfo: pm.playerId,
        selectedRound: pm.selectedRound, roundInfo: pm.selectedRound,
        productName: pm.product.name, category: pm.product.category,
        createdAt: serverTimestamp()
      };
      if (pm.payMethod === 'wallet') {
        if (userBalance.value < pm.selectedPkg.price) return showPopup('error', 'Low Balance', 'Insufficient balance.', 'Deposit');
        showPopup('confirm', 'Confirm Purchase', `Deduct ৳${pm.selectedPkg.price} from wallet?`, 'Confirm', async () => {
          popup.value.show = false; purchaseModal.value.show = false;
          try {
            await runTransaction(db, async (t) => {
              const uRef = doc(db, 'users', uid);
              const uDoc = await t.get(uRef);
              if (uDoc.data().balance < pm.selectedPkg.price) throw 'Low Balance';
              t.update(uRef, { balance: uDoc.data().balance - pm.selectedPkg.price });
              t.set(doc(collection(db, 'orders')), { ...orderData, status: 'pending', paymentMethod: 'wallet' });
            });
            await addReferralCommission(uid, pm.selectedPkg.price);
            await updateTurnoverProgress(uid, pm.selectedPkg.price);
            mem.del('orders_' + uid); sess.del('orders_' + uid);
            showPopup('success', 'Order Placed!', 'Your order is pending for delivery.', 'Orders');
          } catch (e) { showPopup('error', 'Failed', 'Transaction failed. Try again.'); }
        });
      } else if (pm.payMethod === 'direct') {
        if (!pm.trxId || pm.trxId.length < 5) return showPopup('error', 'Invalid TrxID', 'সঠিক Transaction ID দিন।');
        pm.verifying = true;
        try {
          const trxId = pm.trxId.trim().toUpperCase(), price = pm.selectedPkg.price;
          let verifyOk = false, verifyMsg = '';
          try {
            const txSnap = await getDoc(doc(db, 'transactions', trxId));
            if (txSnap.exists()) {
              const txData = txSnap.data();
              if (txData.status === 'used') verifyMsg = 'এই TrxID আগেই ব্যবহার হয়েছে।';
              else if (Number(txData.amount) !== price) verifyMsg = `Amount মিলছে না।`;
              else { await updateDoc(doc(db, 'transactions', trxId), { status: 'used', usedBy: uid, usedAt: serverTimestamp() }); verifyOk = true; }
            }
          } catch (fe) {}
          if (!verifyOk && !verifyMsg && PAYMENT_CONFIG_READY && PAYMENT_SCRIPT_URL) {
            try {
              const vRes = await fetch(`${PAYMENT_SCRIPT_URL}?trxID=${trxId}&apiKey=${PAYMENT_CLIENT_KEY}&amount=${price}`);
              if (vRes.ok) { const vData = await vRes.json(); verifyOk = vData.status === 'success'; verifyMsg = vData.message || ''; }
            } catch (fe) {}
          }
          if (verifyOk) {
            await addDoc(collection(db, 'orders'), { ...orderData, status: 'processing', paymentMethod: pm.gateway + '_auto', trxId, isAutoVerified: true });
            await addReferralCommission(uid, price);
            pm.show = false;
            showPopup('success', 'Payment Verified! ✅', 'আপনার অর্ডার সম্পন্ন হয়েছে।', 'Orders');
          } else showPopup('error', 'Verification Failed ❌', verifyMsg || 'TrxID মিলছে না।');
        } catch (e) { showPopup('error', 'Error', 'Connection failed. Try again.'); }
        finally { pm.verifying = false; }
      } else if (pm.payMethod === 'eps') {
        if (!pm.epsRef || pm.epsRef.length < 4) return showPopup('error', 'EPS Reference', 'EPS Reference নম্বর দিন।');
        pm.verifying = true;
        try {
          await addDoc(collection(db, 'orders'), { ...orderData, status: 'pending', paymentMethod: 'eps', epsRef: pm.epsRef.trim(), isEps: true });
          pm.show = false;
          showPopup('success', 'Order Submitted!', 'EPS পেমেন্ট যাচাই হলে অর্ডার প্রসেস হবে।', 'Orders');
        } catch (e) { showPopup('error', 'Error', 'Order submit failed. Try again.'); }
        finally { pm.verifying = false; }
      }
    };

    // Add Money
    const addMoneyStep = ref(1), addAmount = ref(''), addMethod = ref('');
    const addTrxId = ref(''), addEpsRef = ref(''), addError = ref('');
    const addLoading = ref(false), addSuccess = ref(false);
    const addSelectMethod = (m) => { addMethod.value = m; addMoneyStep.value = 3; addTrxId.value = ''; addEpsRef.value = ''; addError.value = ''; };
    const openEpsDepositUrl = () => { window.open(EPS_PAYMENT_URL, '_blank'); };
    const submitEpsDeposit = async () => {
      if (!addEpsRef.value || addEpsRef.value.length < 4) { addError.value = 'EPS Reference নম্বর দিন।'; return; }
      addLoading.value = true; addError.value = '';
      try {
        const uid = localStorage.getItem('userId');
        await addDoc(collection(db, 'deposits'), { userId: uid, method: 'eps', amount: Number(addAmount.value), epsRef: addEpsRef.value.trim(), status: 'pending', type: 'eps_pending', createdAt: serverTimestamp() });
        addSuccess.value = true;
      } catch (e) { addError.value = 'Server error. Try again.'; }
      finally { addLoading.value = false; }
    };
    const verifyAddMoney = async () => {
      if (!addTrxId.value || addTrxId.value.length < 5) { addError.value = '⚠️ সঠিক Transaction ID দিন।'; return; }
      if (!addAmount.value || Number(addAmount.value) <= 0) { addError.value = '⚠️ Amount দিন।'; return; }
      addLoading.value = true; addError.value = '';
      const trxId = addTrxId.value.trim().toUpperCase(), depositAmount = Number(addAmount.value);
      const uid = localStorage.getItem('userId');
      try {
        try {
          const txSnap = await getDoc(doc(db, 'transactions', trxId));
          if (txSnap.exists()) {
            const txData = txSnap.data();
            if (txData.status === 'used') { addError.value = '⚠️ এই Transaction ID আগেই ব্যবহার হয়েছে।'; return; }
            if (Number(txData.amount) !== depositAmount) { addError.value = `❌ Amount মিলছে না।`; return; }
            await runTransaction(db, async (t) => {
              const freshSnap = await t.get(doc(db, 'transactions', trxId));
              if (!freshSnap.exists()) throw new Error('Transaction not found');
              if (freshSnap.data().status === 'used') throw new Error('ALREADY_USED');
              t.update(doc(db, 'transactions', trxId), { status: 'used', usedBy: uid, usedAt: serverTimestamp() });
              t.update(doc(db, 'users', uid), { balance: increment(depositAmount) });
            });
            await addDoc(collection(db, 'deposits'), { userId: uid, method: addMethod.value, amount: depositAmount, trxId, status: 'approved', type: 'verified', createdAt: serverTimestamp() }).catch(() => {});
            await addDoc(collection(db, 'turnovers'), { userId: uid, type: 'deposit', label: `Deposit Turnover (৳${Math.ceil(depositAmount * 0.5)})`, required: Math.ceil(depositAmount * 0.5), done: 0, status: 'active', createdAt: serverTimestamp() }).catch(() => {});
            await fetchTurnovers().catch(() => {});
            addSuccess.value = true;
            return;
          }
        } catch (fbErr) {
          if (fbErr.message === 'ALREADY_USED') { addError.value = '⚠️ এই Transaction ID আগেই ব্যবহার হয়েছে।'; return; }
          if (fbErr.message && fbErr.message !== 'Transaction not found') { addError.value = '❌ Internet connection error।'; return; }
        }
        if (!PAYMENT_CONFIG_READY || !PAYMENT_SCRIPT_URL) { addError.value = '❌ Payment verification system setup হয়নি।'; return; }
        const vRes = await fetch(`${PAYMENT_SCRIPT_URL}?trxID=${trxId}&apiKey=${PAYMENT_CLIENT_KEY}&amount=${depositAmount}`);
        if (!vRes.ok) { addError.value = '❌ Server error।'; return; }
        const vData = await vRes.json();
        if (vData.status === 'success') await _creditDeposit(uid, depositAmount);
        else addError.value = '❌ ' + (vData.message || 'Verification failed.');
      } catch (e) { addError.value = '❌ Internet connection error।'; }
      finally { addLoading.value = false; }
    };
    const _creditDeposit = async (uid, depositAmount) => {
      await updateDoc(doc(db, 'users', uid), { balance: increment(depositAmount) });
      await addDoc(collection(db, 'deposits'), { userId: uid, method: addMethod.value, amount: depositAmount, trxId: addTrxId.value.trim().toUpperCase(), status: 'approved', type: 'verified', createdAt: serverTimestamp() });
      await addDoc(collection(db, 'turnovers'), { userId: uid, type: 'deposit', label: `Deposit Turnover (৳${Math.ceil(depositAmount * 0.5)})`, required: Math.ceil(depositAmount * 0.5), done: 0, status: 'active', createdAt: serverTimestamp() });
      await fetchTurnovers();
      addSuccess.value = true;
    };

    // Orders
    const orders = ref([]), ordersLoading = ref(false), orderFilter = ref('all');
    const filteredOrders = computed(() => orderFilter.value === 'all' ? orders.value : orders.value.filter(o => o.status === orderFilter.value));
    const fetchOrders = async () => {
      const uid = localStorage.getItem('userId');
      if (!uid) return;
      ordersLoading.value = true;
      try {
        const cached = mem.get('orders_' + uid);
        if (cached) { orders.value = cached; ordersLoading.value = false; return; }
        const snap = await getDocs(query(collection(db, 'orders'), where('userId', '==', uid)));
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        orders.value = list;
        mem.set('orders_' + uid, list);
      } catch (e) {} finally { ordersLoading.value = false; }
    };

    // Codes
    const codes = ref([]), codesLoading = ref(false);
    const fetchCodes = async () => {
      const uid = localStorage.getItem('userId');
      if (!uid) return;
      codesLoading.value = true;
      try {
        const snap = await getDocs(query(collection(db, 'orders'), where('userId', '==', uid), where('type', '==', 'code')));
        codes.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (e) {} finally { codesLoading.value = false; }
    };

    // Chat
    const chatMessages = ref([]), chatInput = ref(''), adminTyping = ref(false), adminOnline = ref(false);
    const chatUnsubscribe = ref(null);
    let chatRoomId = null;
    const watchAdminStatus = () => {
      try {
        onSnapshot(doc(db, 'settings', 'adminStatus'), (snap) => {
          adminOnline.value = snap.exists() ? snap.data().online === true : false;
        });
      } catch(e) { adminOnline.value = false; }
    };
    const initChat = async () => {
      const user = auth.currentUser;
      if (!user) return;
      const uid = user.uid;
      chatRoomId = uid;
      const roomRef = doc(db, 'chats', chatRoomId);
      try {
        const roomSnap = await getDoc(roomRef);
        if (!roomSnap.exists()) {
          await setDoc(roomRef, { userId: uid, userName: userData.value.name || 'User', userEmail: userData.value.email || '', lastMsg: '', lastMsgAt: serverTimestamp(), unreadAdmin: 0 });
        }
      } catch (e) {}
      const msgsRef = collection(db, 'chats', chatRoomId, 'messages');
      const q = query(msgsRef, orderBy('createdAt', 'asc'), limit(100));
      if (chatUnsubscribe.value) chatUnsubscribe.value();
      chatUnsubscribe.value = onSnapshot(q, (snap) => {
        chatMessages.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        nextTick(() => { const el = document.getElementById('chatBox'); if (el) el.scrollTop = el.scrollHeight; });
      }, () => {
        getDocs(collection(db, 'chats', chatRoomId, 'messages')).then(snap => {
          let msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          msgs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
          chatMessages.value = msgs;
        });
      });
      try { onSnapshot(roomRef, (snap) => { if (snap.exists()) adminTyping.value = snap.data().adminTyping || false; }); } catch(e) {}
    };
    const sendChat = async () => {
      if (!chatInput.value.trim()) return;
      const user = auth.currentUser;
      if (!user) { navigateTo('login'); return; }
      const uid = user.uid, text = chatInput.value.trim();
      chatInput.value = '';
      try {
        await addDoc(collection(db, 'chats', uid, 'messages'), { text, sender: 'user', createdAt: serverTimestamp(), read: false });
        await updateDoc(doc(db, 'chats', uid), { lastMsg: text, lastMsgAt: serverTimestamp(), unreadAdmin: increment(1) });
      } catch (e) { chatInput.value = text; showPopup('error', 'Chat Error', 'মেসেজ পাঠানো যায়নি।'); }
    };
    const formatMsgTime = (ts) => {
      if (!ts) return '';
      const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    };

    // Balance History
    const balanceHistory = ref([]), balanceHistoryLoading = ref(false), pendingWithdrawals = ref([]);
    const cancelWithdraw = async (wdId, amount) => {
      const pw = pendingWithdrawals.value.find(p => p.id === wdId);
      if (!pw || !confirm('এই উইথড্র রিকোয়েস্ট বাতিল করতে চান?')) return;
      pw.cancelling = true;
      try {
        const uid = localStorage.getItem('userId');
        await runTransaction(db, async (t) => {
          const wdRef = doc(db, 'withdrawals', wdId);
          const wdDoc = await t.get(wdRef);
          if (!wdDoc.exists() || wdDoc.data().status !== 'pending') throw new Error('Not cancellable');
          t.update(wdRef, { status: 'cancelled' });
          t.update(doc(db, 'users', uid), { balance: increment(amount) });
        });
        pendingWithdrawals.value = pendingWithdrawals.value.filter(p => p.id !== wdId);
        showToast('✅ বাতিল হয়েছে।');
      } catch (e) { showToast('❌ বাতিল করা যায়নি।'); }
      finally { if (pw) pw.cancelling = false; }
    };
    const fetchBalanceHistory = async () => {
      const uid = localStorage.getItem('userId');
      if (!uid) return;
      balanceHistoryLoading.value = true;
      balanceHistory.value = []; pendingWithdrawals.value = [];
      try {
        const items = [];
        const [depSnap, wdSnap] = await Promise.all([
          getDocs(query(collection(db, 'deposits'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'withdrawals'), where('userId', '==', uid)))
        ]);
        depSnap.forEach(d => {
          const data = d.data();
          if (data.status === 'completed' || data.status === 'approved') {
            items.push({ id: d.id, type: 'deposit', label: 'Deposit', amount: Number(data.amount || 0), note: data.method ? data.method.toUpperCase() : 'Manual', createdAt: data.createdAt });
          }
        });
        wdSnap.forEach(d => {
          const data = d.data();
          if (data.status === 'pending') {
            pendingWithdrawals.value.push({ id: d.id, amount: Number(data.amount || 0), gateway: data.gateway || '', accountNumber: data.accountNumber || '', createdAt: data.createdAt, cancelling: false });
          } else if (data.status === 'completed' || data.status === 'approved') {
            items.push({ id: d.id, type: 'withdraw', label: 'Withdraw', amount: Number(data.amount || 0), note: data.gateway ? data.gateway.toUpperCase() : '', createdAt: data.createdAt });
          }
        });
        try {
          const logSnap = await getDocs(query(collection(db, 'balanceLogs'), where('userId', '==', uid)));
          logSnap.forEach(d => {
            const data = d.data();
            const typeMap = {
              'daily_bonus': { label: 'Daily Bonus' }, 'referral': { label: 'Refer Earn' },
              'admin_credit': { label: data.note || 'Admin Credit' }, 'admin_debit': { label: 'Admin Debit' }
            };
            const t = typeMap[data.type] || { label: data.type || 'Adjustment' };
            items.push({ id: d.id, type: data.type, label: t.label, amount: Math.abs(Number(data.amount || 0)), isDebit: data.type === 'admin_debit' || data.amount < 0, note: data.note || data.reason || '', createdAt: data.createdAt });
          });
        } catch (e) {}
        items.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        pendingWithdrawals.value.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        balanceHistory.value = items;
      } catch (e) {} finally { balanceHistoryLoading.value = false; }
    };

    // Stats
    const fetchStats = async () => {
      const uid = localStorage.getItem('userId');
      if (!uid) return;
      const cached = mem.get('stats_' + uid);
      if (cached) { stats.value = cached; return; }
      try {
        const snap = await getDocs(query(collection(db, 'orders'), where('userId', '==', uid)));
        let spent = 0, count = 0, weekly = 0;
        const oneWeekAgo = new Date(); oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        snap.forEach(d => {
          const data = d.data();
          if (data.status === 'completed') {
            spent += Number(data.price || 0); count++;
            const od = data.createdAt ? data.createdAt.toDate() : new Date();
            if (od >= oneWeekAgo) weekly += Number(data.price || 0);
          }
        });
        const result = { totalSpent: spent, totalOrders: count, weeklySpent: weekly };
        stats.value = result; mem.set('stats_' + uid, result);
      } catch (e) {}
    };

    // Utilities
    const copyNum = (num) => { if (num) { navigator.clipboard.writeText(num).catch(() => {}); showToast('✅ Copied: ' + num); } };
    const copyCode = (code) => { navigator.clipboard.writeText(code).catch(() => {}); showToast('✅ Code Copied!'); };
    const imgError = (e) => { e.target.src = 'https://placehold.co/400x400/1c1c28/6c63ff?text=H24'; };
    const getMinPrice = (item) => { if (item.packages?.length > 0) return Math.min(...item.packages.map(p => p.price)); return item.price || 0; };
    const formatDate = (ts) => {
      if (!ts) return 'Processing...';
      const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000);
      return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    };
    const iconMap = {
      facebook: 'fa-brands fa-facebook-f', instagram: 'fa-brands fa-instagram',
      tiktok: 'fa-brands fa-tiktok', youtube: 'fa-brands fa-youtube',
      telegram: 'fa-brands fa-telegram', whatsapp: 'fa-brands fa-whatsapp'
    };

    const accountMenu = computed(() => [
      { label: 'My Orders', sub: 'Track your purchases', icon: 'fa-solid fa-receipt', color: '#6c63ff', bg: 'rgba(108,99,255,0.12)', action: () => navigateTo('orders') },
      { label: 'Gift Codes', sub: 'View your codes', icon: 'fa-solid fa-gift', color: '#ffd700', bg: 'rgba(255,215,0,0.12)', action: () => navigateTo('codes') },
      { label: 'Deposit', sub: 'Add money to wallet', icon: 'fa-solid fa-wallet', color: '#22c55e', bg: 'rgba(34,197,94,0.12)', action: () => navigateTo('add-money') },
      { label: 'Withdraw', sub: 'Cash out your balance', icon: 'fa-solid fa-money-bill-transfer', color: '#f97316', bg: 'rgba(249,115,22,0.12)', action: () => openWithdrawModal() },
      { label: 'Balance History', sub: 'Deposit & Withdraw log', icon: 'fa-solid fa-clock-rotate-left', color: '#22d3ee', bg: 'rgba(34,211,238,0.12)', action: () => navigateTo('balance-history') },
      { label: 'Refer & Earn', sub: 'Earn 10% commission', icon: 'fa-solid fa-users', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', action: () => navigateTo('referral') },
      { label: 'Live Support', sub: 'Chat with admin directly', icon: 'fa-solid fa-headset', color: '#ff6b9d', bg: 'rgba(255,107,157,0.12)', action: () => navigateTo('chat') },
      { label: 'Live Stream', sub: 'Watch live events', icon: 'fa-solid fa-video', color: '#ef4444', bg: 'rgba(239,68,68,0.12)', action: () => navigateTo('live') },
    ]);

    // Navigation
    const pageHistory = ref(['home']);
    let toastTimer = null;
    const showToast = (msg, duration = 2200) => {
      const el = document.getElementById('toast-el');
      if (!el) return;
      el.textContent = msg; el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    };

    let backPressedOnce = false, backPressTimer = null;
    const navigateTo = (newPage) => {
      if (newPage === page.value) return;
      pageHistory.value.push(newPage);
      page.value = newPage;
      history.pushState({ depth: pageHistory.value.length }, '', window.location.href);
    };
    const navigateBack = () => {
      if (pageHistory.value.length > 1) {
        pageHistory.value.pop();
        page.value = pageHistory.value[pageHistory.value.length - 1];
        backPressedOnce = false; clearTimeout(backPressTimer);
      } else {
        if (backPressedOnce) {
          backPressedOnce = false; clearTimeout(backPressTimer);
          if (window.Android?.closeApp) window.Android.closeApp();
          else history.go(-(history.length));
        } else {
          backPressedOnce = true;
          showToast('🔙 আবার Back চাপুন বের হতে');
          backPressTimer = setTimeout(() => { backPressedOnce = false; }, 2000);
          history.pushState({ depth: 1 }, '', window.location.href);
        }
      }
    };

    const openLiveLink = () => navigateTo('live');
    const copyLiveUrl = () => { if (liveUrl.value) { navigator.clipboard.writeText(liveUrl.value).catch(() => {}); showToast('✅ Live link copied!'); } };
    const resetZoom = () => {
      const meta = document.querySelector('meta[name=viewport]');
      if (meta) {
        meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=0');
        setTimeout(() => { meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=0, viewport-fit=cover'); }, 50);
      }
    };
    const goLive = () => { if (liveUrl.value) window.location.href = liveUrl.value; };

    watch(page, async (newPage) => {
      if (newPage === 'orders') fetchOrders();
      if (newPage === 'codes') fetchCodes();
      if (newPage === 'account') { fetchStats(); fetchReferralStats(); if (!_turnoversLoaded.value) fetchTurnovers(); }
      if (newPage === 'referral') fetchReferralStats();
      if (newPage === 'balance-history') fetchBalanceHistory();
      if (newPage === 'chat') { await nextTick(); initChat(); }
      if (newPage === 'live') {
        liveLoading.value = true;
        try {
          const data = await smartGet(doc(db, 'settings', 'live'), 'settings_live');
          if (data) liveUrl.value = data.url || '';
        } catch (e) { liveUrl.value = ''; }
        liveLoading.value = false;
      }
      if (newPage === 'add-money') { addMoneyStep.value = 1; addSuccess.value = false; addError.value = ''; addEpsRef.value = ''; }
    });

    // Parallel data loading
    const loadAllSettingsAndProducts = async () => {
      const [nSnap, annSnap, logoSnap, pSnap, sSnap, amtSnap, roundsSnap, sheetsSnap] = await Promise.all([
        getDoc(doc(db, 'settings', 'notice')),
        getDoc(doc(db, 'settings', 'announcement')),
        getDoc(doc(db, 'settings', 'logo')),
        getDoc(doc(db, 'settings', 'payment')),
        getDoc(doc(db, 'admin', 'settings')),
        getDoc(doc(db, 'settings', 'amounts')),
        getDoc(doc(db, 'settings', 'rounds')),
        getDoc(doc(db, 'settings', 'sheetInfo'))
      ]);

      if (nSnap.exists()) { noticeMessage.value = nSnap.data().text; sess.set('settings_notice', nSnap.data()); }
      if (annSnap.exists()) { announcementLines.value = annSnap.data().lines || []; sess.set('settings_announcement', annSnap.data()); }
      if (logoSnap.exists()) { logoUrl.value = logoSnap.data().url || ''; sess.set('settings_logo', logoSnap.data()); }
      if (pSnap.exists()) { adminNumbers.value = pSnap.data(); sess.set('settings_payment', pSnap.data()); }
      if (sSnap.exists()) { socials.value = sSnap.data(); sess.set('admin_settings', sSnap.data()); }
      if (amtSnap.exists()) {
        const d = amtSnap.data();
        if (d.depositAmounts?.length) depositQuickAmounts.value = d.depositAmounts;
        if (d.withdrawAmounts?.length) withdrawQuickAmounts.value = d.withdrawAmounts;
        if (d.minWithdraw) minWithdraw.value = Number(d.minWithdraw);
        sess.set('settings_amounts', d);
      }
      if (roundsSnap.exists() && roundsSnap.data().list) { rounds.value = roundsSnap.data().list; sess.set('settings_rounds', roundsSnap.data()); }
      if (sheetsSnap.exists() && sheetsSnap.data().list) { sheetOptions.value = sheetsSnap.data().list; sess.set('settings_sheetInfo', sheetsSnap.data()); }

      const hasCachedProds = !!sess.get('products_cache');
      const hasCachedBanners = !!sess.get('banners_cache');
      if (!hasCachedProds || !hasCachedBanners) {
        const [prodSnap, bannerSnap] = await Promise.all([
          hasCachedProds ? Promise.resolve(null) : getDocs(collection(db, 'products')),
          hasCachedBanners ? Promise.resolve(null) : getDocs(collection(db, 'banners'))
        ]);
        if (prodSnap) {
          const prodArr = [];
          mysteryBoxes.value = []; specialOffers.value = []; gameItems.value = []; otherItems.value = [];
          prodSnap.forEach(d => {
            const item = { id: d.id, ...d.data() };
            prodArr.push(item);
            const cat = item.category;
            if (cat === 'mystery') mysteryBoxes.value.push(item);
            else if (cat === 'special') specialOffers.value.push(item);
            else if (cat === 'freefire' || cat === 'ingame') gameItems.value.push(item);
            else if (cat === 'shell' || cat === 'giftcard' || cat === 'subscription') otherItems.value.push(item);
            else gameItems.value.push(item);
          });
          sess.set('products_cache', prodArr);
        }
        if (bannerSnap) {
          const bArr = bannerSnap.docs.map(d => ({ image: d.data().image || '', link: d.data().link || '', productId: d.data().productId || '' }));
          banners.value = bArr; sess.set('banners_cache', bArr);
        }
      }
    };

    onMounted(async () => {
      // Anti-zoom
      document.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
      let lastTouchEnd = 0;
      document.addEventListener('touchend', (e) => { const now = Date.now(); if (now - lastTouchEnd < 300) e.preventDefault(); lastTouchEnd = now; }, { passive: false });
      document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
      document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
      document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
      document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

      // Scroll hide nav
      let lastScrollY = 0;
      document.addEventListener('scroll', (e) => {
        if (e.target?.classList?.contains('page-scroll')) {
          const cy = e.target.scrollTop;
          if (cy > lastScrollY + 8 && cy > 50) navHidden.value = true;
          else if (cy < lastScrollY - 8 || cy < 10) navHidden.value = false;
          lastScrollY = cy;
        }
      }, true);

      history.pushState({ depth: 1 }, '', window.location.href);
      window.addEventListener('popstate', () => navigateBack());

      // ── INSTANT: session cache ──
      preloadFromCache();

      watchAdminStatus();

      // ── ✅ FIX: Auth State Listener ──
      // onAuthStateChanged একবারই fire হবে, persist থাকবে
      onAuthStateChanged(auth, async (user) => {
        if (user) {
          isLoggedIn.value = true;
          localStorage.setItem('userId', user.uid);

          const markOnline = () =>
            updateDoc(doc(db, 'users', user.uid), { isOnline: true, lastSeen: serverTimestamp() }).catch(() => {});
          markOnline();
          setInterval(markOnline, 60000);

          const markOffline = () =>
            updateDoc(doc(db, 'users', user.uid), { isOnline: false, lastSeen: serverTimestamp() }).catch(() => {});
          window.addEventListener('beforeunload', markOffline);
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) markOffline(); else markOnline();
          });

          // ── Real-time balance (সবসময় fresh) ──
          onSnapshot(doc(db, 'users', user.uid), (d) => {
            if (d.exists()) {
              userBalance.value = d.data().balance || 0;
              userAvatar.value = d.data().photoURL || 'https://i.pravatar.cc/150?img=12';
              userData.value = d.data();
              const uid = user.uid.replace(/\D/g, '');
              supportPin.value = uid.length > 5 ? uid.substring(0, 6) : Math.floor(100000 + Math.random() * 900000);
            }
          });

          checkTodayCheckin(user.uid);
          fetchTurnovers();

        } else {
          // ── লগইন নেই: login পেজে পাঠান ──
          isLoggedIn.value = false;
          userBalance.value = 0;
          userData.value = {};
          if (page.value !== 'login' && page.value !== 'register') {
            navigateTo('login');
          }
        }
      });

      // ── Background data load ──
      loadAllSettingsAndProducts().then(async () => {
        await nextTick();
        if (banners.value.length > 0) {
          setTimeout(() => {
            new Swiper('.mySwiper', {
              loop: true,
              autoplay: { delay: 3500, disableOnInteraction: false },
              pagination: { el: '.swiper-pagination', clickable: true }
            });
          }, 100);
        }
      }).catch(() => {});

      checkAppVersion();
    });

    return {
      page, isLoggedIn, userBalance, userAvatar, userData,
      noticeMessage, logoUrl, banners, mysteryBoxes, specialOffers, gameItems, otherItems,
      socials, iconMap, liveUrl, liveLoading, adminNumbers, supportPin,
      stats, minWithdraw, rounds, sheetOptions, navHidden,
      depositQuickAmounts, withdrawQuickAmounts,
      updateModal, ptrVisible, ptrLoading, ptrTouchStart, ptrTouchMove, ptrTouchEnd,
      turnoverModal, turnoverTab, turnoverLoading, activeTurnovers, completedTurnovers, openTurnoverModal,
      announcementLines, announcementModal, showAnnouncement,
      navigateTo, navigateBack, showToast,
      checkInClaimed, claimDailyBonus,
      referralStats, referralLink, copyReferralLink, shareReferral,
      openSocialLink, popup, closePopup, showPopup,
      withdrawModal, openWithdrawModal, submitWithdraw,
      loginEmail, loginPass, loginLoading, handleEmailLogin, handleGoogleLogin,
      regName, regPhone, regEmail, regPass, regConfirm, regReferralCode, regLoading, handleRegister,
      handleLogout, goProtected, handleBannerClick,
      purchaseModal, openPurchase, handlePurchaseBuy, handleEpsPurchaseRedirect,
      addMoneyStep, addAmount, addMethod, addTrxId, addEpsRef, addError, addLoading, addSuccess,
      addSelectMethod, verifyAddMoney, submitEpsDeposit, openEpsDepositUrl,
      orders, ordersLoading, orderFilter, filteredOrders,
      codes, codesLoading,
      balanceHistory, balanceHistoryLoading, pendingWithdrawals, cancelWithdraw,
      chatMessages, chatInput, adminTyping, adminOnline, sendChat, formatMsgTime,
      openLiveLink, copyLiveUrl, resetZoom, goLive,
      accountMenu, copyNum, copyCode, imgError, getMinPrice, formatDate
    };
  }
}).mount('#app');