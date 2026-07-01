"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// Firebase — proper npm package imports (replaces the previous gstatic.com CDN imports)
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  setPersistence, browserLocalPersistence, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc, writeBatch,
} from "firebase/firestore";

// ══════════════════════════════════════════════════════════════════════════════
// FIREBASE CONFIG — Replace these placeholder values with your actual Firebase
// project credentials. Get them from: Firebase Console → Project Settings →
// Your Apps → Web App → Config object.
//
// Steps to set up (all free on Spark plan):
// 1. Go to https://console.firebase.google.com → New Project
// 2. Add a Web App → copy the config below
// 3. Enable Authentication → Sign-in method → Google → Enable
// 4. Enable Firestore Database → Start in production mode → choose region
// 5. Paste your Firestore Security Rules (see bottom of file)
// ══════════════════════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC5tZjFJLp7ODzQinnccSI5RubozXSC8MA",
  authDomain:        "haq-prep.firebaseapp.com",
  projectId:         "haq-prep",
  storageBucket:     "haq-prep.firebasestorage.app",
  messagingSenderId: "289834449140",
  appId:             "1:289834449140:web:1199fadadff4c411ec06a1",
};
// ══════════════════════════════════════════════════════════════════════════════
// FIRESTORE SECURITY RULES (paste into Firebase Console → Firestore → Rules)
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     match /users/{userId}/{document=**} {
//       allow read, write: if request.auth != null && request.auth.uid == userId;
//     }
//   }
// }
//
// This ensures each user can ONLY read/write their own data. Zero cross-user
// data leakage. No admin access needed.
// ══════════════════════════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────────────────────────
const MARKS_CORRECT = 4, MARKS_WRONG = -1, TIMER_DEFAULT = 90;
const PAL = ["#4ade80","#60a5fa","#f472b6","#fb923c","#a78bfa","#34d399","#fbbf24","#f87171","#38bdf8","#c084fc"];
const STAT_COLORS = { unattempted:"#334155", correct:"#4ade80", wrong:"#f87171", skipped:"#fbbf24", bookmarked:"#a78bfa" };
const LIB_KEY = "ha-cbt-lib-v1", REV_KEY = "ha-cbt-rev-v1", ANALYTICS_KEY = "ha-cbt-analytics-v1", SRS_KEY = "ha-cbt-srs-v1";
const FOLDERS_KEY = "ha-cbt-folders-v1";
const GUEST_KEY = "ha-cbt-guest-mode"; // flag: "guest" | "cloud"

// ── SRS Intervals (days) — SM-2 simplified ───────────────────────────────────
const SRS_INTERVALS = [1, 3, 7, 14, 30];
const srsNextDate = (rep, correct) => {
  const today = todayStr();
  const d = new Date(today);
  if (!correct) { d.setDate(d.getDate() + 1); return { due: d.toISOString().slice(0,10), rep: 0 }; }
  // Use the CURRENT rep to pick the interval (0 → 1 day, 1 → 3 days, ...),
  // then advance rep for the following review. This avoids skipping the
  // 1-day interval on a fresh question's first correct answer.
  const curRep = Math.min(rep, SRS_INTERVALS.length - 1);
  d.setDate(d.getDate() + SRS_INTERVALS[curRep]);
  const nextRep = Math.min(rep + 1, SRS_INTERVALS.length - 1);
  return { due: d.toISOString().slice(0,10), rep: nextRep };
};

// ── MCQ Prompt ───────────────────────────────────────────────────────────────
const MCQ_PROMPT = `I have attached my study material (PDF/notes). Generate MCQs from it in JSON format for my CBT practice app.

Output ONLY this JSON format, nothing else:
{"title":"Topic Name","questions":[
{"id":1,"topic":"sub-topic name","type":"std","q":"Question text here?","opts":["Option A","Option B","Option C","Option D"],"ans":0,"exp":"Brief explanation."},
...
]}

TYPE CODES:
- std   = standard single-correct MCQ
- ar    = Assertion-Reason (Both true R explains A / Both true R doesn't explain / A true R false / A false R true)
- stmt  = statement-based (Statement I & II true/false combos)
- match = matching (List-I vs List-II, 4 combo options)
- num   = numerical / fill-in type

Rules:
- Scan the FULL material first — build a concept inventory before writing a single question
- Type distribution: 35% stmt, 30% ar, 20% std, 15% match/num — generate in that order
- Distractors must be near-misses — same category, wrong detail — never obviously wrong
- Cover all sections proportionally — don't over-represent early pages
- Each question tests ONE concept. No two questions test the same fact.
- ans = 0-indexed (0=A, 1=B, 2=C, 3=D)
- exp = 1-2 sentences: why correct answer is right AND why the most tempting wrong answer is wrong
- topic field = sub-topic name, not just chapter name
- No serial numbers or labels inside the question text
- Difficulty mix: 30% easy, 40% medium, 30% hard

LARGE PDF HANDLING:
- If material is large (>50 pages or >60 concepts), generate Part 1 first, then pause
- Close the JSON cleanly — never cut mid-question
- After the JSON, tell me what sections remain and that I should type "continue" for the next part
- On "continue": resume from next section, IDs carry forward, zero concept repetition

Output ONLY the JSON block + a brief coverage note after it. No intro text, no markdown fences.`;

// ── Helpers ──────────────────────────────────────────────────────────────────
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=0|Math.random()*(i+1);[a[i],a[j]]=[a[j],a[i]];} return a; };
const fmtTime = s => `${String(0|s/60).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const mkColors = qs => { const c={}; [...new Set(qs.map(q=>q.topic||"General"))].forEach((t,i)=>c[t]=PAL[i%10]); return c; };
const todayStr = () => new Date().toISOString().slice(0,10);

// ── Streak Helpers ────────────────────────────────────────────────────────────
const calcStreak = (sessions) => {
  if (!sessions || sessions.length === 0) return { current: 0, best: 0 };
  const days = [...new Set(sessions.map(s => s.date))].sort();
  let best = 1, streak = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const diff = (new Date(days[i]) - new Date(days[i-1])) / 86400000;
    if (diff === 1) streak++;
    else streak = 1;
    if (streak > best) best = streak;
  }
  let cur = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const diff = (new Date(days[i]) - new Date(days[i-1])) / 86400000;
    if (diff === 1) cur++;
    else break;
  }
  const lastDay = days[days.length - 1];
  const gap = (new Date(todayStr()) - new Date(lastDay)) / 86400000;
  if (gap > 1) cur = 0;
  return { current: cur, best };
};

// ── Set Grade Helper ──────────────────────────────────────────────────────────
// Grade is based on "problem %" — the share of the FULL set that is a problem
// question: ever answered wrong (cumulative), currently bookmarked, OR never
// attempted at all (skipping ≠ progress). Requires at least 1 attempted
// session; unplayed sets stay "?" (ungraded).
const calcGrade = (sessions, setTitle, revData, totalQs) => {
  const setSessions = (sessions||[]).filter(s => s.setTitle === setTitle);
  if (setSessions.length === 0 || totalQs === 0) return { grade: "?", problemPct: 0, color: "#64748b", borderColor: "#33415540", bg: "#1e293b" };
  const attSet = revData.att || new Set();
  const problemIds = new Set([...revData.bk, ...revData.inc]);
  for (let i = 1; i <= totalQs; i++) { if (!attSet.has(i)) problemIds.add(i); }
  const problemPct = Math.round(problemIds.size / totalQs * 100);
  // Grade scale (based on problem % of the full set, not just attempted questions)
  let grade, color, borderColor, bg;
  if (problemPct <= 3) {
    grade = "S"; color = "#2dd4bf"; borderColor = "#2dd4bf50"; bg = "#0d2a2a";
  } else if (problemPct < 10) {
    grade = "A"; color = "#4ade80"; borderColor = "#4ade8050"; bg = "#0d2a1f";
  } else if (problemPct < 20) {
    grade = "B"; color = "#60a5fa"; borderColor = "#60a5fa50"; bg = "#0f1a2d";
  } else if (problemPct < 35) {
    grade = "C"; color = "#fbbf24"; borderColor = "#fbbf2450"; bg = "#2a1f0a";
  } else {
    grade = "D"; color = "#f87171"; borderColor = "#f8717150"; bg = "#2a0a0a";
  }
  return { grade, problemPct, color, borderColor, bg };
};

// Tip for next grade shown in result screen
const gradeNextTip = (grade, problemPct) => {
  if (grade === "S") return "🏆 You've mastered this set!";
  if (grade === "A") return `Get to ≤3% needing work to reach Grade S. Keep it up!`;
  if (grade === "B") return `Get below 10% needing work to reach Grade A. ${problemPct - 9}% to go.`;
  if (grade === "C") return `Get below 20% needing work to reach Grade B. Focus on incorrect, bookmarked & unattempted questions.`;
  if (grade === "D") return `Get below 35% needing work to reach Grade C. Attack those problem questions!`;
  return "Complete at least one quiz to get graded.";
};

// ── Skill File Content ────────────────────────────────────────────────────────
const SKILL_FILE_CONTENT = `---
name: mcq-json
description: "Trigger when user wants MCQs in JSON format — for CBT artifact, question bank, or when user says 'mcq-json', 'json', 'for my artifact', 'paste into artifact', 'generate questions from this'. Works for ANY competitive exam following MCQ pattern (ICAR JRF, NET, NABARD, UPSC, GATE, state PSC, university exams, etc.). Always output compact JSON compatible with the CBT artifact schema. Never use this for readable chat/Word output — use icar-mcq-generator for that."
---

# MCQ JSON Generator

You generate exam-quality MCQs from source material and output compact JSON for the CBT library artifact. You work for ANY competitive exam — ICAR JRF, NET, NABARD, UPSC, GATE, or any MCQ-pattern exam. Never assume a specific exam unless the user tells you.

---

## RULE 0 — ANTI-HALLUCINATION (absolute priority, overrides everything)

Generate questions ONLY from what is explicitly stated in the source material provided. Do NOT add facts, values, mechanisms, names, numbers, or context from your training data — even if you know them to be true. If a concept is mentioned in the source but incompletely described, generate what you can from what IS there. Every single fact in every question, option, and explanation must be directly traceable to the source. When in doubt — leave it out.

---

## OUTPUT FORMAT

No intro text. No preamble. Output starts with a single SUMMARY LINE, then JSON (in a \`\`\`json code block), then COVERAGE NOTE.

JSON schema:
\`\`\`
{"title":"[Topic Name]","questions":[
{"id":1,"topic":"[sub-topic name]","type":"std","q":"[question text only — no serial number, no label]","opts":["A. option1","B. option2","C. option3","D. option4"],"ans":0,"exp":"[1-2 sentence explanation — why correct answer is right AND why the most tempting wrong answer is wrong]"},
...
]}
\`\`\`

### match type format (exact — always use this structure):
\`\`\`
"q":"Match List-I with List-II:\\nList-I: (a) X  (b) Y  (c) Z  (d) W\\nList-II: (1) P  (2) Q  (3) R  (4) S",
"opts":["A. a-1, b-2, c-3, d-4","B. a-2, b-1, c-4, d-3","C. a-3, b-4, c-1, d-2","D. a-4, b-3, c-2, d-1"]
\`\`\`

### stmtn type format (exact — always use this structure):
\`\`\`
"q":"How many of the following statements are correct?\\n1. [statement]\\n2. [statement]\\n3. [statement]\\n4. [statement]",
"opts":["A. Only one","B. Only two","C. Only three","D. All four"]
\`\`\`

---

## TYPE CODES

| Code | Format | Priority |
|------|--------|----------|
| stmtn | Multi-statement "how many are correct" — 4-5 statements, options are Only one/two/three/All four | Highest |
| stmt | Classic 2-statement — Statement I and Statement II true/false combo | High |
| ar | Assertion-Reason — fixed 4 options always (see Phase 4) | High |
| match | List-I vs List-II — ONLY when source has classifications, lists, or pairings | Medium |
| num | Numerical/specific value — ONLY when source has numbers, ratios, temperatures, doses | Medium |
| std | Standard single-line direct MCQ | LAST RESORT ONLY |

---

## PHASE 1 — CONCEPT INVENTORY (mandatory before writing a single question)

Scan the ENTIRE source top to bottom. Build this inventory INTERNALLY — do NOT output it in full. After completing the inventory, output ONLY this single summary line before the JSON:

\`\`\`
Concepts: N | Est. questions: N–N | Sessions: 1 (or 2 — [reason])
\`\`\`

### Internal tier classification (do not output — use for question prioritisation):
- **Tier A** — Mechanisms, exceptions, comparative concepts (X vs Y), specific numerical values, cause-effect relationships, named phenomena with conditions → highest priority, hardest format first
- **Tier B** — Definitions, classifications, processes, sequences, groupings → medium priority
- **Tier C** — Basic facts, simple names, straightforward definitions → easy questions only (30% of total)

Generate Tier A concepts first, then B, then C.

---

## PHASE 2 — QUESTION COUNT LOGIC (no preset number)

Question count is determined entirely by the source. Never set an arbitrary cap. Never pad to reach a number.

### Step 1 — Minimum from concept inventory
Every distinct concept = at minimum 1 question. This sets the floor.

### Step 2 — Format richness check per concept
Generate a second question on the same concept ONLY IF a different format tests a genuinely different angle. Ask: "Would a student who correctly answered question 1 automatically get question 2 right?" If yes — skip the second question. If no — generate it.

### Step 3 — Session decision
After estimating from Steps 1+2, default to ONE session. Only split to 2 when concept count genuinely exceeds single-response capacity.

---

## PHASE 3 — TYPE DISTRIBUTION (source-adaptive, not fixed percentages)

Priority order: stmtn → ar → stmt → match (only if lists exist) → num (only if numbers exist) → std (last resort, <15%)

---

## PHASE 4 — QUESTION QUALITY STANDARDS

### ar — fixed options always in this exact order:
- A. Both A and R are true and R is the correct explanation of A
- B. Both A and R are true but R is NOT the correct explanation of A
- C. A is true but R is false
- D. A is false but R is true

The hardest ar pattern (≥40% of ar questions): Both A and R are individually true, but R does NOT mechanistically explain A.

---

## PHASE 5 — SECTION BALANCE
Early section: max 35% | Middle: min 30% | Late: min 25% | Cross-section: ~10%

---

## PHASE 6 — PRE-OUTPUT SELF-AUDIT (all 7 checks mandatory)
1. Rule 0 — every fact from source only
2. Tier A coverage complete
3. Section balance met
4. ar trap check (≥40% "both true, R doesn't explain A")
5. No duplicate questions
6. Type appropriateness (no forced match/num)
7. JSON validity — ans is 0-indexed, last two chars are ]}

---

## TOKEN CUTOFF PROTOCOL
If limit approaches: stop, close with ]}, write coverage note. Fewer questions with valid JSON always beats more questions with broken JSON.

---

## FINAL OUTPUT STRUCTURE
1. SUMMARY LINE: \`Concepts: N | Est. questions: N–N | Sessions: 1\`
2. JSON block (in \`\`\`json code block)
3. COVERAGE NOTE with type breakdown, sub-topics covered, and session 2 status
`;

// ── Weak Topic Helper ─────────────────────────────────────────────────────────
const getWeakTopics = (sessions, minSessions = 2, threshold = 50) => {
  const topicMap = {};
  sessions.forEach(s => {
    if (!s.topicStats) return;
    Object.entries(s.topicStats).forEach(([topic, st]) => {
      if (!topicMap[topic]) topicMap[topic] = { correct: 0, wrong: 0, skipped: 0 };
      topicMap[topic].correct += st.correct || 0;
      topicMap[topic].wrong += st.wrong || 0;
      topicMap[topic].skipped += st.skipped || 0;
    });
  });
  return Object.entries(topicMap)
    .filter(([, st]) => { const total = st.correct + st.wrong; return total >= minSessions; })
    .map(([topic, st]) => {
      const total = st.correct + st.wrong;
      const acc = total > 0 ? Math.round(st.correct / total * 100) : 0;
      return { topic, acc, correct: st.correct, wrong: st.wrong, total };
    })
    .filter(t => t.acc < threshold)
    .sort((a, b) => a.acc - b.acc)
    .slice(0, 3);
};

// ── Share Code ────────────────────────────────────────────────────────────────
const encodeSet = (set) => {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify({ title: set.title, questions: set.questions })))); }
  catch { return null; }
};
const decodeSet = (code) => {
  try { return JSON.parse(decodeURIComponent(escape(atob(code.trim())))); }
  catch { return null; }
};

// ── Local Storage (Guest mode) ────────────────────────────────────────────────
const loadS = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : {}; } catch { return {}; } };
const saveS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ── Normalise MCQ JSON ────────────────────────────────────────────────────────
const norm = (q, i) => {
  const text = q.q||q.question||q.Question||q.text||q.stem||"";
  let opts = [];
  const raw = q.options??q.opts??q.choices??q.Options??null;
  if(Array.isArray(raw)&&raw.length>=2){
    opts = raw.map(v=>typeof v==="object"?v.text||v.value||JSON.stringify(v):String(v)).filter(s=>s.trim());
  } else if(raw&&typeof raw==="object"&&!Array.isArray(raw)){
    for(const ks of[["a","b","c","d"],["A","B","C","D"],["1","2","3","4"]]){
      if(ks.some(k=>raw[k]!=null)){opts=ks.map(k=>String(raw[k]||""));break;}
    }
    if(!opts.length) opts=Object.values(raw).map(String);
  }
  if(opts.length<2){
    for(const ks of[["option_a","option_b","option_c","option_d"],["optionA","optionB","optionC","optionD"]]){
      const f=ks.map(k=>q[k]).filter(v=>v!=null&&String(v).trim());
      if(f.length>=2){opts=f.map(String);break;}
    }
  }
  if(opts.length<2){
    for(const ks of[["a","b","c","d"],["A","B","C","D"]]){
      const f=ks.map(k=>q[k]).filter(v=>typeof v==="string"&&v.trim());
      if(f.length>=2){opts=f;break;}
    }
  }
  while(opts.length<4) opts.push(`Option ${String.fromCharCode(65+opts.length)}`);
  opts = opts.slice(0,4);
  let ans = 0;
  const ra = q.answer??q.correct_answer??q.correct??q.ans??q.Answer??q.correctAnswer??0;
  if(typeof ra==="number"){ ans=Math.max(0,Math.min(3,Math.round(ra))); }
  else if(typeof ra==="string"){
    const t=ra.trim().toLowerCase();
    const m=t.match(/^\(?([a-d])\)?/)||t.match(/([a-d])/);
    if(m) ans=["a","b","c","d"].indexOf(m[1]);
    else if(!isNaN(t)&&t){const n=parseInt(t);ans=n>=1&&n<=4?n-1:Math.max(0,Math.min(3,n));}
  }
  return {
    id: i+1, topic: q.topic||q.category||q.subject||"General",
    type: q.type||q.question_type||"standard", q: text, options: opts, answer: ans,
    explanation: q.exp||q.explanation||q.explain||q.rationale||q.reason||""
  };
};

// ════════════════════════════════════════════════════════════════════════════════
// FIREBASE MODULE — loaded dynamically so the app still works in guest mode
// even if Firebase config keys haven't been set yet.
// ════════════════════════════════════════════════════════════════════════════════
let _firebaseApp = null, _auth = null, _db = null;
const firebaseConfigured = () =>
  FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "PASTE_YOUR_API_KEY_HERE";

const initFirebase = async () => {
  if (_auth) return {
    auth: _auth, db: _db,
    GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
    setPersistence, browserLocalPersistence, signOut, onAuthStateChanged,
    doc, setDoc, getDoc, collection, getDocs, deleteDoc, writeBatch,
  };
  if (!firebaseConfigured()) throw new Error("Firebase not configured yet.");

  if (!getApps().length) _firebaseApp = initializeApp(FIREBASE_CONFIG);
  else _firebaseApp = getApps()[0];

  _auth = getAuth(_firebaseApp);
  _db = getFirestore(_firebaseApp);

  return {
    auth: _auth, db: _db,
    GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
    setPersistence, browserLocalPersistence, signOut, onAuthStateChanged,
    doc, setDoc, getDoc, collection, getDocs, deleteDoc, writeBatch,
  };
};

// ── Cloud read/write helpers (called only when logged in) ────────────────────
const cloudSave = async (uid, collection_name, key, data) => {
  const fb = await initFirebase();
  const { doc, setDoc } = fb;
  await setDoc(doc(fb.db, "users", uid, collection_name, key), { data, updatedAt: Date.now() });
};

const cloudGet = async (uid, collection_name) => {
  const fb = await initFirebase();
  const { collection, getDocs } = fb;
  const snap = await getDocs(collection(fb.db, "users", uid, collection_name));
  const result = {};
  snap.forEach(d => { result[d.id] = d.data().data; });
  return result;
};

const cloudDelete = async (uid, collection_name, key) => {
  const fb = await initFirebase();
  const { doc, deleteDoc } = fb;
  await deleteDoc(doc(fb.db, "users", uid, collection_name, key));
};



// (AuthScreen removed — auth buttons now live directly on SplashScreen)

// ════════════════════════════════════════════════════════════════════════════════
// CLOUD SYNC BANNER — shown at top of library for logged-in users
// ════════════════════════════════════════════════════════════════════════════════
function SyncBanner({ user, syncStatus, onSync, onSignOut }) {
  const [showMenu, setShowMenu] = useState(false);
  const statusColor = syncStatus === "synced" ? "#4ade80" : syncStatus === "syncing" ? "#fbbf24" : syncStatus === "error" ? "#f87171" : "#64748b";
  const statusText = syncStatus === "synced" ? "✓ Synced" : syncStatus === "syncing" ? "⟳ Syncing…" : syncStatus === "error" ? "⚠ Sync error" : "Cloud";

  return (
    <div style={{background:"#0d2a1f",border:"1px solid #166534",borderRadius:12,padding:"10px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:10,position:"relative"}}>
      <img src={user.photoURL||""} alt="" style={{width:28,height:28,borderRadius:"50%",background:"#334155",flexShrink:0}} onError={e=>{e.target.style.display="none";}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:"#f1f5f9",fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.displayName||user.email}</div>
        <div style={{color:statusColor,fontSize:10,marginTop:1}}>{statusText}</div>
      </div>
      <button onClick={onSync} title="Sync now" style={{background:"#0d1117",border:"1px solid #166534",borderRadius:8,padding:"5px 9px",color:"#4ade80",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>↻</button>
      <button onClick={()=>setShowMenu(v=>!v)} style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"5px 9px",color:"#94a3b8",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>⋯</button>
      {showMenu && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#161b22",border:"1px solid #21262d",borderRadius:10,padding:6,zIndex:50,minWidth:140}}>
          <button onClick={()=>{setShowMenu(false);onSignOut();}} style={{width:"100%",background:"none",border:"none",color:"#f87171",padding:"8px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",textAlign:"left",borderRadius:7}}>
            🚪 Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// GUEST WARNING BANNER — weekly export nudge
// ════════════════════════════════════════════════════════════════════════════════
function GuestBanner({ setCount, onBackup, onSignIn }) {
  const [dismissed, setDismissed] = useState(() => {
    const d = localStorage.getItem("ha-guest-banner-dismissed");
    if (!d) return false;
    return (Date.now() - parseInt(d)) < 7 * 24 * 60 * 60 * 1000;
  });
  if (dismissed || setCount === 0) return null;
  return (
    <div style={{background:"#2d1a0a",border:"1px solid #92400e",borderRadius:12,padding:"12px 14px",marginBottom:10}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
        <div style={{flex:1}}>
          <div style={{color:"#fbbf24",fontSize:12,fontWeight:700,marginBottom:4}}>👤 Guest Mode — Back up your data</div>
          <div style={{color:"#78716c",fontSize:11,lineHeight:1.6,marginBottom:10}}>You have {setCount} set{setCount!==1?"s":""} saved locally. Export your library backup weekly so you don't lose progress.</div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            <button onClick={onBackup} style={{background:"#fbbf24",color:"#0f172a",border:"none",borderRadius:8,padding:"7px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🗄️ Export Backup</button>
            <button onClick={onSignIn} style={{background:"#0d1117",color:"#2dd4bf",border:"1px solid #2dd4bf40",borderRadius:8,padding:"7px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>☁️ Switch to Cloud</button>
          </div>
        </div>
        <button onClick={()=>{setDismissed(true);localStorage.setItem("ha-guest-banner-dismissed",Date.now().toString());}} style={{background:"none",border:"none",color:"#78716c",fontSize:16,cursor:"pointer",padding:0,flexShrink:0}}>✕</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// SPLASH SCREEN — with Option D auth buttons (Google prominent + Guest icon)
// ════════════════════════════════════════════════════════════════════════════════
function SplashScreen({ user, onGoogle, onGuest, onContinue, onSignOut, loading, error }) {
  return (
    <div style={{fontFamily:"'Segoe UI',system-ui,sans-serif",minHeight:"100vh",background:"#0d1117",display:"flex",flexDirection:"column",padding:"32px 28px 24px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-60,right:-60,width:320,height:320,background:"radial-gradient(circle, #2dd4bf20 0%, transparent 70%)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",bottom:80,left:-40,width:200,height:200,background:"radial-gradient(circle, #0d948815 0%, transparent 70%)",pointerEvents:"none"}}/>

      {/* Top bar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",zIndex:1}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:56,height:56,borderRadius:14,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 20px #2dd4bf40"}}>
            <img src="/icon-192.png" alt="HAQ PREP logo" width={56} height={56} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
          <span style={{color:"#f1f5f9",fontSize:19,fontWeight:700,letterSpacing:"0.3px"}}>HAQ PREP</span>
        </div>
        <div style={{background:"#161b22",border:"1px solid #21262d",borderRadius:8,padding:"5px 12px",color:"#94a3b8",fontSize:12,fontWeight:600}}>v10.1</div>
      </div>

      {/* Hero */}
      <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",zIndex:1,paddingTop:40}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:7,border:"1.5px solid #21262d",borderRadius:99,padding:"7px 16px",marginBottom:36,width:"fit-content"}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:"#2dd4bf"}}/>
          <span style={{color:"#2dd4bf",fontSize:11,fontWeight:700,letterSpacing:"1.5px"}}>AI-POWERED CBT PRACTICE</span>
        </div>

        <div style={{marginBottom:44}}>
          <h1 style={{fontSize:52,fontWeight:800,lineHeight:1.1,margin:"0 0 4px",color:"#f1f5f9",letterSpacing:"-1.5px"}}>Study actively.</h1>
          <h1 style={{fontSize:52,fontWeight:800,lineHeight:1.1,margin:0,color:"#2dd4bf",letterSpacing:"-1.5px"}}>Revise smartly.</h1>
        </div>

        {user ? (
          /* Signed-in confirmation banner + Continue */
          <div style={{marginBottom:14}}>
            <div style={{background:"#161b22",border:"1px solid #166534",borderRadius:14,padding:"14px 16px",display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
              {user.photoURL ? (
                <img src={user.photoURL} alt={user.displayName||"Profile"} width={44} height={44} referrerPolicy="no-referrer" style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",flexShrink:0}}/>
              ) : (
                <div style={{width:44,height:44,borderRadius:"50%",background:"#0d2a1f",display:"flex",alignItems:"center",justifyContent:"center",color:"#4ade80",fontSize:18,fontWeight:700,flexShrink:0}}>{(user.displayName||"U").charAt(0).toUpperCase()}</div>
              )}
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{color:"#f1f5f9",fontSize:14,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.displayName||"Signed in"}</span>
                  <span style={{width:18,height:18,borderRadius:"50%",background:"#16a34a",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"#f1f5f9",fontSize:11,fontWeight:700,flexShrink:0}}>✓</span>
                </div>
                <div style={{color:"#64748b",fontSize:11,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.email||"Signed in with Google"}</div>
              </div>
              <button onClick={onSignOut} style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:9,padding:"7px 12px",color:"#94a3b8",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>Sign Out</button>
            </div>
            <button onClick={onContinue} style={{width:"100%",background:"#2dd4bf",color:"#0f172a",border:"none",borderRadius:14,padding:"15px 12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>Continue →</button>
          </div>
        ) : (
          /* Option D — Google big, Guest small icon box */
          <div style={{display:"flex",gap:10,marginBottom:14}}>
            {/* Google — takes 2/3 width */}
            <button onClick={onGoogle} disabled={loading} style={{flex:2,background:"#f1f5f9",color:"#0f172a",border:"none",borderRadius:14,padding:"15px 12px",fontSize:14,fontWeight:700,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:10,opacity:loading?0.7:1}}>
              {loading ? (
                <><span style={{width:16,height:16,border:"2px solid #0f172a44",borderTopColor:"#0f172a",borderRadius:"50%",display:"inline-block",animation:"spin 0.8s linear infinite"}}/> Signing in…</>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                  Sign in with Google
                </>
              )}
            </button>

            {/* Guest — compact icon box */}
            <button onClick={onGuest} style={{flex:1,background:"#161b22",color:"#64748b",border:"1.5px solid #21262d",borderRadius:14,padding:"15px 8px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              <span style={{fontSize:20}}>👤</span>
              <span>Guest</span>
            </button>
          </div>
        )}

        {error && (
          <div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"10px 14px",color:"#fca5a5",fontSize:12,marginBottom:8,lineHeight:1.6}}>⚠️ {error}</div>
        )}
        {!firebaseConfigured() && (
          <div style={{background:"#161b22",border:"1px solid #21262d",borderRadius:10,padding:"9px 13px",color:"#475569",fontSize:11,lineHeight:1.6,marginBottom:4}}>
            🔧 Firebase not set up — Google sign-in unavailable. Guest mode works fine.
          </div>
        )}
        <div style={{color:"#334155",fontSize:11,textAlign:"center",marginTop:4}}>No account needed · works offline</div>
      </div>

      {/* Footer */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,zIndex:1,paddingTop:8}}>
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M10 3C7.2 3 5 5.2 5 8c0 1.4.5 2.6 1.4 3.5C5.5 12.1 5 13.1 5 14.2c0 .9.7 1.6 1.6 1.8V17h6.8v-1c.9-.2 1.6-.9 1.6-1.8 0-1.1-.5-2.1-1.4-2.7C14.5 10.6 15 9.4 15 8c0-2.8-2.2-5-5-5z" fill="#2dd4bf" opacity="0.7"/></svg>
        <span style={{color:"#475569",fontSize:12}}>By <span style={{color:"#2dd4bf",fontWeight:600}}>Harsh Anand</span> · Built with AI</span>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── About Screen ──────────────────────────────────────────────────────────────
function AboutScreen({ onStart, onHome }) {
  const [copied, setCopied] = useState(false);
  const [skillDownloaded, setSkillDownloaded] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const copyPrompt = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = MCQ_PROMPT;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      navigator.clipboard?.writeText(MCQ_PROMPT).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => {});
    }
  };
  const downloadSkill = () => {
    try {
      const blob = new Blob([SKILL_FILE_CONTENT], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "mcq-json.md";
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      setSkillDownloaded(true);
      setTimeout(() => setSkillDownloaded(false), 3000);
    } catch { alert("Download failed. Please use the Copy option instead."); }
  };
  return (
    <div style={{fontFamily:"'Segoe UI',sans-serif",minHeight:"100vh",background:"#0d1117",color:"#f1f5f9",padding:20,paddingBottom:48}}>
      <div style={{maxWidth:560,margin:"0 auto",paddingTop:8}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:28}}>
          <button onClick={onHome} style={{display:"inline-flex",alignItems:"center",gap:7,background:"#161b22",border:"1px solid #21262d",borderRadius:10,padding:"8px 14px 8px 10px",cursor:"pointer",fontFamily:"inherit"}}>
            <div style={{width:20,height:20,borderRadius:6,background:"#0d1117",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
            <span style={{color:"#64748b",fontSize:12,fontWeight:600}}>Back</span>
          </button>
          <div style={{textAlign:"right"}}>
            <div style={{color:"#f1f5f9",fontSize:15,fontWeight:700}}>About</div>
            <div style={{color:"#475569",fontSize:11,marginTop:1}}>HAQ PREP · v10.1</div>
          </div>
        </div>
        <div style={{background:"linear-gradient(160deg,#13241f 0%,#161b22 55%)",borderRadius:18,padding:"22px 20px",border:"1px solid #1f3b34",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:14,paddingBottom:18,marginBottom:18,borderBottom:"1px solid #21372f"}}>
            <div style={{width:60,height:60,borderRadius:16,overflow:"hidden",border:"2px solid #2dd4bf55",flexShrink:0,boxShadow:"0 0 22px #2dd4bf22"}}>
              <img src="/icon-192.png" alt="Harsh Anand" width={60} height={60} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            </div>
            <div style={{minWidth:0}}>
              <div style={{color:"#2dd4bf",fontSize:19,fontWeight:800,letterSpacing:"-0.3px"}}>Harsh Anand</div>
              <div style={{color:"#5eead4",fontSize:12,fontWeight:600,marginTop:3,lineHeight:1.4}}>Institute of Agricultural Sciences, BHU</div>
            </div>
          </div>
          <div style={{lineHeight:1.85}}>
            <p style={{color:"#cbd5e1",fontSize:13,margin:"0 0 12px"}}>Hey, I'm <span style={{color:"#2dd4bf",fontWeight:700}}>Harsh Anand</span>, a student at the <span style={{color:"#2dd4bf",fontWeight:700}}>Institute of Agricultural Sciences, BHU</span>.</p>
            <p style={{color:"#cbd5e1",fontSize:13,margin:"0 0 12px"}}>I built HAQ Prep out of frustration.</p>
            <p style={{color:"#cbd5e1",fontSize:13,margin:"0 0 16px"}}>For a long time I kept reading my notes again and again, thinking I was studying. But when actual exam questions showed up, reality hit. I wasn't retaining as much as I thought.</p>
            <div style={{background:"linear-gradient(135deg,#0d2a1f,#0f2620)",border:"1px solid #2dd4bf40",borderLeft:"4px solid #2dd4bf",borderRadius:"0 14px 14px 0",padding:"18px 20px",margin:"0 0 16px",textAlign:"center",boxShadow:"0 0 24px #2dd4bf18"}}>
              <p style={{color:"#5eead4",fontSize:16,fontWeight:800,fontStyle:"italic",margin:0,lineHeight:1.45,letterSpacing:"-0.2px"}}>"Your mistakes are your best teachers."</p>
            </div>
            <p style={{color:"#cbd5e1",fontSize:13,margin:"0 0 12px"}}>The real learning started when I began practicing MCQs, getting questions wrong, analyzing them, and attacking my weak areas.</p>
            <p style={{color:"#cbd5e1",fontSize:13,margin:"0 0 12px"}}>I'm not a coder. Zero technical background. Just an idea, curiosity, and AI.</p>
            <p style={{color:"#cbd5e1",fontSize:13,margin:"0 0 16px"}}>Using HAQ Prep is simple. Generate MCQs from your notes or PDF using any AI, paste them here, and start practicing in real CBT mode. That's it.</p>
            <p style={{color:"#64748b",fontSize:12,margin:0,fontStyle:"italic"}}>— Harsh Anand, IAS, BHU</p>
          </div>
        </div>
        <div style={{background:"#161b22",borderRadius:16,padding:"18px 20px",border:"1px solid #21262d",marginBottom:14}}>
          <div style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:18}}>HOW TO USE</div>
          {[["1","Open Claude.ai and upload your PDF or paste your notes"],["2","Copy the prompt below → paste it in Claude with your material"],["3","Copy the JSON output Claude gives you"],["4","Come back here → Import JSON → Name your set → Save"],["5","Hit Practice and attempt like a real exam 🎯"]].map(([n,text],i,arr)=>(
            <div key={n} style={{display:"flex",gap:14,alignItems:"flex-start",position:"relative",paddingBottom:i===arr.length-1?0:18}}>
              {i!==arr.length-1 && <div style={{position:"absolute",left:13,top:28,bottom:0,width:2,background:"#2dd4bf30"}}/>}
              <div style={{width:28,height:28,minWidth:28,borderRadius:"50%",background:"#0d2a1f",border:"1.5px solid #2dd4bf",color:"#2dd4bf",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0,zIndex:1,boxShadow:"0 0 12px #2dd4bf25"}}>{n}</div>
              <span style={{color:"#cbd5e1",fontSize:13,lineHeight:1.6,paddingTop:4}}>{text}</span>
            </div>
          ))}
        </div>
        <div style={{background:"#161b22",borderRadius:16,padding:"18px 20px",border:"1px solid #21262d",marginBottom:14}}>
          <button onClick={()=>setPromptOpen(o=>!o)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",marginBottom:promptOpen?14:0}}>
            <div style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:1}}>📋 MCQ GENERATION PROMPT</div>
            <span style={{display:"inline-flex",alignItems:"center",gap:6,color:"#2dd4bf",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{promptOpen?"Tap to collapse":"Tap to expand"}<span style={{fontSize:9}}>{promptOpen?"▲":"▼"}</span></span>
          </button>
          {promptOpen && (<>
          {/* Option 1 — Quick way */}
          <div style={{background:"#0d1f1c",border:"1px solid #2dd4bf30",borderRadius:12,padding:"14px 14px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{background:"#2dd4bf22",color:"#2dd4bf",fontSize:10,fontWeight:800,padding:"3px 9px",borderRadius:99,letterSpacing:0.5,whiteSpace:"nowrap"}}>OPTION 1</span>
              <span style={{color:"#5eead4",fontSize:13,fontWeight:800}}>Quick way</span>
              <span style={{color:"#475569",fontSize:10,fontWeight:600}}>(no setup)</span>
            </div>
            <p style={{color:"#94a3b8",fontSize:12,lineHeight:1.65,margin:"0 0 12px"}}>Copy the prompt → paste it in Claude.ai with your PDF → copy the JSON output → import it in HAQ PREP.</p>
            <div style={{background:"#0d1117",borderRadius:10,padding:14,border:"1px solid #1e293b",color:"#64748b",fontSize:11,lineHeight:1.7,fontFamily:"monospace",whiteSpace:"pre-wrap",maxHeight:150,overflowY:"auto",marginBottom:10}}>{MCQ_PROMPT}</div>
            <button onClick={copyPrompt} style={{width:"100%",background:copied?"#2dd4bf22":"#2dd4bf18",color:"#2dd4bf",border:`1.5px solid ${copied?"#2dd4bf":"#2dd4bf50"}`,borderRadius:9,padding:"11px 10px",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
              {copied?"✅ Copied!":"📋 Copy Prompt"}
            </button>
          </div>
          {/* OR divider */}
          <div style={{display:"flex",alignItems:"center",gap:12,margin:"14px 0"}}>
            <div style={{flex:1,height:1,background:"#21262d"}}/>
            <span style={{color:"#475569",fontSize:11,fontWeight:800,letterSpacing:1}}>OR</span>
            <div style={{flex:1,height:1,background:"#21262d"}}/>
          </div>
          {/* Option 2 — Smart way */}
          <div style={{background:"#13102a",border:"1px solid #7c3aed40",borderRadius:12,padding:"14px 14px 16px",position:"relative"}}>
            <span style={{position:"absolute",top:-9,right:12,background:"linear-gradient(90deg,#7c3aed,#a78bfa)",color:"#fff",fontSize:8,fontWeight:800,padding:"2px 8px",borderRadius:99,letterSpacing:0.5,whiteSpace:"nowrap"}}>★ RECOMMENDED</span>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{background:"#7c3aed30",color:"#c4b5fd",fontSize:10,fontWeight:800,padding:"3px 9px",borderRadius:99,letterSpacing:0.5,whiteSpace:"nowrap"}}>OPTION 2</span>
              <span style={{color:"#c4b5fd",fontSize:13,fontWeight:800}}>Smart way</span>
              <span style={{color:"#475569",fontSize:10,fontWeight:600}}>(one time setup)</span>
            </div>
            <p style={{color:"#94a3b8",fontSize:12,lineHeight:1.65,margin:"0 0 12px"}}>Download the Skill file → install it in Claude Desktop once → after that just upload your PDF and type <span style={{color:"#c4b5fd",fontWeight:700,fontFamily:"monospace"}}>"mcq-json"</span> — it will automatically generate HAQ PREP ready JSON. No prompt needed every time.</p>
            <button onClick={downloadSkill} style={{width:"100%",background:skillDownloaded?"#1a1438":"linear-gradient(135deg,#1a1a2e,#16213e)",color:skillDownloaded?"#a78bfa":"#c4b5fd",border:`1.5px solid ${skillDownloaded?"#a78bfa":"#7c3aed60"}`,borderRadius:9,padding:"11px 10px",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:5,marginBottom:10}}>
              {skillDownloaded?"✅ Downloaded!":"⬇ Download Skill"}
            </button>
            {/* Install steps */}
            <div style={{background:"#0d0a1f",border:"1px solid #7c3aed25",borderRadius:10,padding:"10px 12px"}}>
              <div style={{color:"#a78bfa",fontSize:9,fontWeight:800,letterSpacing:0.5,marginBottom:7}}>HOW TO INSTALL THE SKILL IN CLAUDE</div>
              {[
                ["1","Tap ⬇ Download Skill — saves a mcq-json.md file to your device"],
                ["2","Open Claude Desktop → Settings → Skills → Install file"],
                ["3","Upload your PDF in Claude — it generates HAQ PREP JSON automatically ✨"],
              ].map(([n,text])=>(
                <div key={n} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:n==="3"?0:6}}>
                  <div style={{minWidth:16,height:16,borderRadius:"50%",background:"#7c3aed22",color:"#a78bfa",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,flexShrink:0,marginTop:1}}>{n}</div>
                  <span style={{color:"#94a3b8",fontSize:10,lineHeight:1.6}}>{text}</span>
                </div>
              ))}
              <div style={{marginTop:8,paddingTop:7,borderTop:"1px solid #21262d",fontSize:9,color:"#475569"}}>
                No Claude Desktop? Use <span style={{color:"#64748b",fontWeight:700}}>Copy</span> and paste manually — works on Claude.ai too.
              </div>
            </div>
          </div>
          </>)}
        </div>
        <div style={{background:"#161b22",borderRadius:16,padding:"18px 20px",border:"1px solid #21262d",marginBottom:20}}>
          <div style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:14}}>📬 CONTACT & FEEDBACK</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <a href="mailto:harshcapricorn777@gmail.com" style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:8,textDecoration:"none",background:"#0d1117",border:"1px solid #2dd4bf25",borderRadius:12,padding:"16px 12px"}}>
              <div style={{width:40,height:40,borderRadius:11,background:"#2dd4bf15",border:"1px solid #2dd4bf30",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontSize:18}}>✉️</span></div>
              <div style={{width:"100%"}}><div style={{color:"#94a3b8",fontSize:10,fontWeight:700,marginBottom:3,letterSpacing:0.5}}>EMAIL</div><div style={{color:"#2dd4bf",fontSize:11,fontWeight:600,wordBreak:"break-all",lineHeight:1.4}}>harshcapricorn777@gmail.com</div></div>
            </a>
            <a href="https://instagram.com/_harsh_transurfing" target="_blank" rel="noreferrer" style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:8,textDecoration:"none",background:"#0d1117",border:"1px solid #f472b625",borderRadius:12,padding:"16px 12px"}}>
              <div style={{width:40,height:40,borderRadius:11,background:"#f472b615",border:"1px solid #f472b630",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontSize:18}}>📸</span></div>
              <div style={{width:"100%"}}><div style={{color:"#94a3b8",fontSize:10,fontWeight:700,marginBottom:3,letterSpacing:0.5}}>INSTAGRAM</div><div style={{color:"#f472b6",fontSize:12,fontWeight:600,wordBreak:"break-all",lineHeight:1.4}}>@_harsh_transurfing</div></div>
            </a>
          </div>
        </div>
        <button onClick={onStart} style={{background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:14,padding:16,fontSize:16,fontWeight:700,cursor:"pointer",width:"100%",fontFamily:"inherit",marginBottom:16}}>
          Start Practicing →
        </button>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7,paddingBottom:8}}>
          <span style={{color:"#475569",fontSize:11}}>By <span style={{color:"#2dd4bf",fontWeight:600}}>Harsh Anand</span> · Built with AI</span>
        </div>
      </div>
    </div>
  );
}

// ── Review Card ───────────────────────────────────────────────────────────────
function ReviewCard({ q, a }) {
  const [open, setOpen] = useState(false);
  const col = a?.correct ? "#4ade80" : a?.skipped ? "#fbbf24" : "#f87171";
  return (
    <div style={{background:"#161b22",borderRadius:12,border:`1px solid ${col}33`,marginBottom:8,overflow:"hidden"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",background:"none",border:"none",padding:"14px 16px",textAlign:"left",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,fontFamily:"inherit"}}>
        <div style={{display:"flex",alignItems:"flex-start",gap:10,flex:1,minWidth:0}}>
          <span style={{minWidth:20,height:20,borderRadius:"50%",background:col+"33",color:col,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0,marginTop:1}}>{a?.correct?"✓":a?.skipped?"→":"✗"}</span>
          <span style={{color:"#f1f5f9",fontSize:13,lineHeight:1.5,flex:1}}>{q.q.split("\n")[0]}</span>
        </div>
        <span style={{color:col,fontSize:14,flexShrink:0}}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{padding:"0 16px 14px"}}>
          {q.options.map((o,i)=>(
            <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:6}}>
              <span style={{minWidth:20,height:20,borderRadius:"50%",background:i===q.answer?"#4ade8033":a?.selected===i&&i!==q.answer?"#f8717133":"#1e293b",color:i===q.answer?"#4ade80":a?.selected===i&&i!==q.answer?"#f87171":"#64748b",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0,marginTop:2}}>{String.fromCharCode(65+i)}</span>
              <span style={{color:i===q.answer?"#4ade80":a?.selected===i&&i!==q.answer?"#f87171":"#64748b",fontSize:13,lineHeight:1.4}}>{o}</span>
            </div>
          ))}
          <div style={{background:"#0d2a1f",borderRadius:8,padding:10,marginTop:8}}>
            <div style={{color:"#4ade80",fontSize:10,fontWeight:700,marginBottom:4}}>💡 EXPLANATION</div>
            <p style={{color:"#86efac",fontSize:12,lineHeight:1.5,margin:0}}>{q.explanation||"No explanation provided."}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Export Modal ──────────────────────────────────────────────────────────────
function ExportModal({ set, onClose }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify({ title: set.title, questions: set.questions }, null, 2);
  const doCopy = () => {
    try {
      const ta = document.createElement("textarea"); ta.value = json; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      setCopied(true); setTimeout(()=>setCopied(false), 2500);
    } catch { navigator.clipboard?.writeText(json).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2500); }).catch(()=>{}); }
  };
  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:20,padding:24,width:"100%",maxWidth:520,border:"1px solid #21262d",maxHeight:"90vh",display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <h2 style={{color:"#f1f5f9",fontSize:17,margin:0}}>⬇ Export JSON</h2>
          <button onClick={onClose} style={{background:"#0d1117",color:"#94a3b8",border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
        <div style={{color:"#94a3b8",fontSize:11,fontWeight:700,marginBottom:6}}>"{set.title}" · {set.questions.length} questions</div>
        <textarea readOnly value={json} onFocus={e=>e.target.select()} style={{flex:1,minHeight:200,maxHeight:340,background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:12,color:"#64748b",fontSize:10,fontFamily:"monospace",resize:"none",outline:"none",lineHeight:1.6,overflowY:"auto"}}/>
        <div style={{display:"flex",gap:10,marginTop:14}}>
          <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Close</button>
          <button onClick={doCopy} style={{flex:2,background:copied?"#0d2a1f":"linear-gradient(90deg,#0d9488,#2dd4bf)",color:copied?"#4ade80":"#0f172a",border:copied?"1px solid #4ade80":"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{copied ? "✅ Copied!" : "📋 Copy JSON"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Backup Modal ──────────────────────────────────────────────────────────────
function BackupModal({ lib, rev, analytics, srs, folders, isCloud, user, onRestoreComplete, onClose }) {
  const [tab, setTab] = useState("export");
  const [restoreStatus, setRestoreStatus] = useState("");
  const [restoreMsg, setRestoreMsg] = useState("");
  const [restorePreview, setRestorePreview] = useState(null);
  const [pendingData, setPendingData] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const fileRef = useRef();

  const doExport = () => {
    const backup = { backup_version: 2, app: "HAQ PREP", exported_at: new Date().toISOString().slice(0,10), sets_count: Object.keys(lib||{}).length, library: lib||{}, revision: rev||{}, analytics: analytics||{}, srs: srs||{}, folders: folders||{} };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `haqprep-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setRestoreStatus(""); setRestoreMsg(""); setRestorePreview(null); setPendingData(null); setConfirmed(false);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.backup_version || !data.library) throw new Error("Not a valid HAQ PREP backup file.");
        setRestorePreview({ setsCount: Object.keys(data.library||{}).length, sessionsCount: (data.analytics?.sessions||[]).length, srsCount: Object.keys(data.srs||{}).length, date: data.exported_at });
        setPendingData(data);
      } catch (err) { setRestoreStatus("error"); setRestoreMsg(err.message||"Could not read file."); }
    };
    reader.readAsText(file);
  };

  const doRestore = async () => {
    if (!pendingData) return;
    setRestoring(true);
    try {
      // Merge backup data into current data (backup wins on key collisions)
      const mergedLib       = { ...(lib||{}),       ...(pendingData.library||{})   };
      const mergedRev       = { ...(rev||{}),        ...(pendingData.revision||{}) };
      const mergedSrs       = { ...(srs||{}),        ...(pendingData.srs||{})      };
      const mergedAnalytics = { ...(analytics||{}),  ...(pendingData.analytics||{})};
      const mergedFolders   = { ...(folders||{}),    ...(pendingData.folders||{})  };

      if (isCloud && user) {
        // Cloud mode: push merged data straight to Firestore so it survives logout/login
        await Promise.all([
          ...Object.entries(mergedLib).map(([k, v]) => cloudSave(user.uid, "library", k, v)),
          ...Object.entries(mergedRev).map(([k, v]) => cloudSave(user.uid, "revision", k, v)),
          ...Object.entries(mergedSrs).map(([k, v]) => cloudSave(user.uid, "srs", k, v)),
          ...Object.entries(mergedFolders).map(([k, v]) => cloudSave(user.uid, "folders", k, v)),
          cloudSave(user.uid, "analytics", "main", mergedAnalytics),
        ]);
      } else {
        // Guest mode: localStorage is the source of truth
        saveS(LIB_KEY, mergedLib); saveS(REV_KEY, mergedRev); saveS(ANALYTICS_KEY, mergedAnalytics); saveS(SRS_KEY, mergedSrs); saveS(FOLDERS_KEY, mergedFolders);
      }

      setRestoreStatus("success"); setRestoreMsg(`✅ Restored ${restorePreview.setsCount} sets. Reloading…`);
      setTimeout(() => { onRestoreComplete({ library: mergedLib, revision: mergedRev, analytics: mergedAnalytics, srs: mergedSrs, folders: mergedFolders }); onClose(); }, 1800);
    } catch {
      setRestoreStatus("error"); setRestoreMsg(isCloud ? "Restore failed. Check your connection and try again." : "Restore failed. Storage may be full.");
    } finally {
      setRestoring(false);
    }
  };

  const tabBtn = (id, label) => (
    <button onClick={()=>{setTab(id);setRestoreStatus("");setRestoreMsg("");setRestorePreview(null);setPendingData(null);setConfirmed(false);}} style={{flex:1,padding:"9px 0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",border:"none",borderRadius:8,background:tab===id?"#2dd4bf":"#0f2d2a",color:tab===id?"#0f172a":"#64748b"}}>{label}</button>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:20,padding:24,width:"100%",maxWidth:520,border:"1px solid #21262d",maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h2 style={{color:"#f1f5f9",fontSize:18,margin:0}}>🗄️ Library Backup</h2>
          <button onClick={onClose} style={{background:"#161b22",color:"#94a3b8",border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
        <div style={{display:"flex",gap:6,marginBottom:18,background:"#0d1117",borderRadius:10,padding:4}}>
          {tabBtn("export","💾 Export")} {tabBtn("restore","📂 Restore")}
        </div>
        {tab === "export" && (
          <>
            <div style={{background:"#0d1117",borderRadius:10,padding:12,marginBottom:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,textAlign:"center"}}>
              {[[Object.keys(lib||{}).length,"#2dd4bf","Sets"],[(analytics?.sessions||[]).length,"#a78bfa","Sessions"]].map(([v,c,l])=>(
                <div key={l} style={{background:"#161b22",borderRadius:8,padding:10}}><div style={{color:c,fontSize:20,fontWeight:700}}>{v}</div><div style={{color:"#64748b",fontSize:10,marginTop:2}}>{l}</div></div>
              ))}
            </div>
            <button onClick={doExport} style={{width:"100%",background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:12,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>💾 Download Backup File</button>
          </>
        )}
        {tab === "restore" && (
          <>
            <div style={{background:"#2d1a0a",border:"1px solid #92400e",borderRadius:10,padding:"10px 12px",color:"#fbbf24",fontSize:11,marginBottom:14,lineHeight:1.7}}>⚠️ Restoring will merge backup sets into your current library.</div>
            <input ref={fileRef} type="file" accept=".json" onChange={handleFile} style={{width:"100%",background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"10px 12px",color:"#94a3b8",fontSize:12,fontFamily:"inherit",boxSizing:"border-box",cursor:"pointer",marginBottom:12}}/>
            {restorePreview && (
              <div style={{background:"#0d2a1f",border:"1px solid #166534",borderRadius:12,padding:14,marginBottom:14}}>
                <div style={{color:"#4ade80",fontSize:12,fontWeight:700,marginBottom:10}}>✅ Valid backup: {restorePreview.setsCount} sets, {restorePreview.sessionsCount} sessions</div>
                <button onClick={()=>setConfirmed(v=>!v)} style={{width:"100%",background:confirmed?"#0f2922":"#0d1117",color:confirmed?"#4ade80":"#94a3b8",border:`1.5px solid ${confirmed?"#4ade80":"#334155"}`,borderRadius:10,padding:"9px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  {confirmed?"☑":"☐"} I understand this will overwrite analytics &amp; SRS
                </button>
              </div>
            )}
            {restoreStatus==="error" && <div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"10px 12px",color:"#fca5a5",fontSize:12,marginBottom:12}}>⚠️ {restoreMsg}</div>}
            {restoreStatus==="success" && <div style={{background:"#0d2a1f",border:"1px solid #166534",borderRadius:10,padding:"10px 12px",color:"#4ade80",fontSize:12,marginBottom:12}}>{restoreMsg}</div>}
            <div style={{display:"flex",gap:10}}>
              <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={doRestore} disabled={!pendingData||!confirmed||restoreStatus==="success"||restoring} style={{flex:2,background:pendingData&&confirmed&&restoreStatus!=="success"?"#2dd4bf":"#1e293b",color:pendingData&&confirmed&&restoreStatus!=="success"?"#0f172a":"#475569",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:pendingData&&confirmed&&restoreStatus!=="success"&&!restoring?"pointer":"not-allowed",fontFamily:"inherit"}}>{restoring?"⏳ Syncing…":"📂 Restore Now"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Share Modal ────────────────────────────────────────────────────────�����──────
function ShareModal({ set, onClose }) {
  const [copied, setCopied] = useState(false);
  const code = encodeSet(set);
  const link = code ? `${window.location.origin}${window.location.pathname}#import=${encodeURIComponent(code)}` : null;
  const copy = () => {
    if (!link) return;
    try {
      const ta = document.createElement("textarea"); ta.value = link; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      setCopied(true); setTimeout(()=>setCopied(false), 2500);
    } catch { navigator.clipboard?.writeText(link).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2500); }).catch(()=>{}); }
  };
  const nativeShare = () => {
    if (link && navigator.share) { navigator.share({ title: `HAQ PREP — ${set.title}`, text: `Import "${set.title}" into HAQ PREP`, url: link }).catch(()=>{}); }
    else copy();
  };
  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:20,padding:24,width:"100%",maxWidth:520,border:"1px solid #21262d"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h2 style={{color:"#f1f5f9",fontSize:18,margin:0}}>🔗 Share Link</h2>
          <button onClick={onClose} style={{background:"#161b22",color:"#94a3b8",border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
        <div style={{background:"#0f1e3a",border:"1px solid #1e3a6e",borderRadius:10,padding:"10px 12px",color:"#93c5fd",fontSize:11,marginBottom:14,lineHeight:1.7}}>📲 Copy this link → send it to anyone (WhatsApp, etc.) → they open it and tap <b>Import</b> to add this set to HAQ PREP.</div>
        <div style={{background:"#0d1117",borderRadius:10,padding:12,border:"1px solid #21262d",color:"#64748b",fontSize:10,fontFamily:"monospace",wordBreak:"break-all",maxHeight:140,overflowY:"auto",lineHeight:1.6,marginBottom:8}}>{link || "Error generating link"}</div>
        <div style={{color:"#475569",fontSize:10,marginBottom:16,textAlign:"center"}}>{link ? "Anyone who opens this link can import the set" : "Error generating link"}</div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Close</button>
          <button onClick={typeof navigator!=="undefined"&&navigator.share?nativeShare:copy} style={{flex:2,background:copied?"#0f2922":"#60a5fa",color:copied?"#4ade80":"#0f172a",border:copied?"1px solid #4ade80":"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{copied?"✅ Copied!":(typeof navigator!=="undefined"&&navigator.share?"📤 Share Link":"📋 Copy Link")}</button>
        </div>
      </div>
    </div>
  );
}

// ── Import-from-Link Modal ────────────────────────────────────────────────────
function ImportLinkModal({ data, onImport, onCancel }) {
  const count = data?.questions?.length || 0;
  return (
    <div style={{position:"fixed",inset:0,background:"#0d1117",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:20,padding:24,width:"100%",maxWidth:420,border:"1px solid #21262d",textAlign:"center"}}>
        <div style={{width:56,height:56,borderRadius:16,overflow:"hidden",margin:"0 auto 14px",boxShadow:"0 0 18px #2dd4bf30"}}>
          <img src="/icon-192.png" alt="HAQ PREP logo" width={56} height={56} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
        </div>
        <h2 style={{color:"#f1f5f9",fontSize:18,margin:"0 0 8px"}}>Import this question set?</h2>
        <p style={{color:"#94a3b8",fontSize:13,lineHeight:1.6,margin:"0 0 6px"}}>Do you want to import this question set into HAQ PREP?</p>
        <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:"12px 14px",margin:"14px 0 20px"}}>
          <div style={{color:"#2dd4bf",fontSize:15,fontWeight:700,marginBottom:2,wordBreak:"break-word"}}>{data?.title || "Shared Set"}</div>
          <div style={{color:"#64748b",fontSize:12}}>{count} question{count===1?"":"s"}</div>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onCancel} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"1px solid #21262d",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={onImport} style={{flex:2,background:"#2dd4bf",color:"#0f172a",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Import</button>
        </div>
      </div>
    </div>
  );
}

// ── JSON Import Modal ─────────────────────────────────────────────────────────
function JsonModal({ onSave, onClose, folders, defaultFolderId }) {
  const [tab, setTab] = useState("json");
  const [json, setJson] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [folderId, setFolderId] = useState(defaultFolderId || "");
  const nameRef = useRef();
  const folderList = Object.entries(folders||{});

  const doSaveJson = () => {
    setErr("");
    try {
      const c = json.trim().replace(/```json|```/g,"").trim();
      let p;
      try { p=JSON.parse(c); } catch { const m=c.match(/\[[\s\S]*\]/); if(m) p=JSON.parse(m[0]); else throw new Error("No valid JSON found"); }
      let qs, title;
      if(Array.isArray(p)){ qs=p; title=nameRef.current?.value.trim()||"Untitled Set"; }
      else if(p&&p.questions){ qs=p.questions; title=nameRef.current?.value.trim()||p.title||"Untitled"; }
      else throw new Error("Expected array or {questions:[...]}");
      if(!qs.length) throw new Error("No questions found");
      onSave({ title, questions: qs.map((q,i)=>norm(q,i)), savedAt: Date.now(), count: qs.length, folderId: folderId||null });
    } catch(e) { setErr(e.message); }
  };

  const doSaveCode = () => {
    setErr("");
    const decoded = decodeSet(code);
    if (!decoded) { setErr("Invalid share code."); return; }
    if (!decoded.questions?.length) { setErr("No questions found in this code."); return; }
    onSave({ title: decoded.title||"Imported Set", questions: decoded.questions, savedAt: Date.now(), count: decoded.questions.length, folderId: folderId||null });
  };

  const folderPicker = (
    <div style={{marginBottom:12}}>
      <label style={{display:"block",color:"#64748b",fontSize:11,fontWeight:600,marginBottom:6}}>Save to folder</label>
      <select value={folderId} onChange={e=>setFolderId(e.target.value)} style={{width:"100%",background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",boxSizing:"border-box",outline:"none"}}>
        <option value="">📄 Unfiled</option>
        {folderList.map(([fkey,folder]) => <option key={fkey} value={fkey}>📁 {folder.name}</option>)}
      </select>
    </div>
  );

  const tabBtn = (id, label) => (
    <button onClick={()=>{setTab(id);setErr("");}} style={{flex:1,padding:"9px 0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",border:"none",borderRadius:8,background:tab===id?"#4ade80":"#0f2d2a",color:tab===id?"#0f172a":"#64748b"}}>{label}</button>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:20,padding:24,width:"100%",maxWidth:520,border:"1px solid #21262d",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h2 style={{color:"#f1f5f9",fontSize:18,margin:0}}>📥 Import Set</h2>
          <button onClick={onClose} style={{background:"#161b22",color:"#94a3b8",border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
        <div style={{display:"flex",gap:6,marginBottom:16,background:"#0d1117",borderRadius:10,padding:4}}>
          {tabBtn("json","📋 Paste JSON")} {tabBtn("code","🔗 Share Code")}
        </div>
        {tab === "json" && (
          <>
            <input ref={nameRef} placeholder="Set name (e.g. Plant Pathology Part-10)" style={{width:"100%",background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",boxSizing:"border-box",outline:"none",marginBottom:12}}/>
            {folderPicker}
            <textarea value={json} onChange={e=>setJson(e.target.value)} placeholder="Paste your MCQ JSON here…" style={{width:"100%",height:200,background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:12,color:"#f1f5f9",fontSize:12,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box",outline:"none",marginBottom:err?8:12}}/>
            {err && <div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"10px 12px",color:"#fca5a5",fontSize:12,marginBottom:12}}>⚠️ {err}</div>}
            <div style={{display:"flex",gap:10}}>
              <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={doSaveJson} disabled={!json.trim()} style={{flex:2,background:json.trim()?"#4ade80":"#1e293b",color:json.trim()?"#0f172a":"#475569",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:json.trim()?"pointer":"not-allowed",fontFamily:"inherit"}}>💾 Save Set</button>
            </div>
          </>
        )}
        {tab === "code" && (
          <>
            <div style={{background:"#0f1e3a",border:"1px solid #1e3a6e",borderRadius:10,padding:"10px 12px",color:"#93c5fd",fontSize:11,marginBottom:14,lineHeight:1.7}}>🔗 Paste the share code your classmate sent you.</div>
            {folderPicker}
            <textarea value={code} onChange={e=>setCode(e.target.value)} placeholder="Paste share code here…" style={{width:"100%",height:120,background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:12,color:"#f1f5f9",fontSize:12,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box",outline:"none",marginBottom:err?8:12}}/>
            {err && <div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"10px 12px",color:"#fca5a5",fontSize:12,marginBottom:12}}>⚠️ {err}</div>}
            <div style={{display:"flex",gap:10}}>
              <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={doSaveCode} disabled={!code.trim()} style={{flex:2,background:code.trim()?"#60a5fa":"#1e293b",color:code.trim()?"#0f172a":"#475569",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:code.trim()?"pointer":"not-allowed",fontFamily:"inherit"}}>🔗 Import from Code</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Rename Modal ──────────────────────────────────────────────────────────────
function RenameModal({ currentTitle, onRename, onClose }) {
  const [val, setVal] = useState(currentTitle);
  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:16,padding:24,width:"100%",maxWidth:380,border:"1px solid #21262d"}}>
        <h2 style={{color:"#f1f5f9",fontSize:16,margin:"0 0 16px"}}>✏️ Rename Set</h2>
        <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&val.trim())onRename(val.trim());}} style={{width:"100%",background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:14,fontFamily:"inherit",boxSizing:"border-box",outline:"none",marginBottom:16}}/>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={()=>val.trim()&&onRename(val.trim())} style={{flex:2,background:"#4ade80",color:"#0f172a",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Folder Name Modal (create or rename) ──────────────────────────────────────
function FolderNameModal({ title, currentValue="", onSubmit, onClose }) {
  const [val, setVal] = useState(currentValue);
  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:16,padding:24,width:"100%",maxWidth:380,border:"1px solid #21262d"}}>
        <h2 style={{color:"#f1f5f9",fontSize:16,margin:"0 0 16px"}}>{title}</h2>
        <input autoFocus value={val} onChange={e=>setVal(e.target.value)} placeholder="e.g. Plant Pathology"
          onKeyDown={e=>{if(e.key==="Enter"&&val.trim())onSubmit(val.trim());}}
          style={{width:"100%",background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:14,fontFamily:"inherit",boxSizing:"border-box",outline:"none",marginBottom:16}}/>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onClose} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={()=>val.trim()&&onSubmit(val.trim())} style={{flex:2,background:"#fbbf24",color:"#0f172a",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Move-to-Folder Modal ────────────────────────────────────────────────────
function MoveToFolderModal({ folders, currentFolderId, onMove, onClose }) {
  const folderList = Object.entries(folders||{});
  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#161b22",borderRadius:16,padding:24,width:"100%",maxWidth:380,border:"1px solid #21262d",maxHeight:"80vh",overflowY:"auto"}}>
        <h2 style={{color:"#f1f5f9",fontSize:16,margin:"0 0 16px"}}>📁 Move to Folder</h2>
        <button onClick={()=>onMove(null)} style={{width:"100%",textAlign:"left",background:!currentFolderId?"#2dd4bf22":"#0d1117",border:`1px solid ${!currentFolderId?"#2dd4bf":"#21262d"}`,borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",cursor:"pointer",marginBottom:8}}>📄 Unfiled</button>
        {folderList.length===0 && <div style={{color:"#64748b",fontSize:12,marginBottom:12}}>No folders yet — create one from the library page first.</div>}
        {folderList.map(([fkey,folder])=>(
          <button key={fkey} onClick={()=>onMove(fkey)} style={{width:"100%",textAlign:"left",background:currentFolderId===fkey?"#2dd4bf22":"#0d1117",border:`1px solid ${currentFolderId===fkey?"#2dd4bf":"#21262d"}`,borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",cursor:"pointer",marginBottom:8}}>📁 {folder.name}</button>
        ))}
        <button onClick={onClose} style={{width:"100%",background:"#161b22",color:"#94a3b8",border:"none",borderRadius:10,padding:12,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",marginTop:4}}>Cancel</button>
      </div>
    </div>
  );
}

// ── Analytics Screen ──────────────────────────────────────────────────────────
function AnalyticsScreen({ analytics, lib, onBack, onReset }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const sessions = analytics?.sessions || [];
  const totalAttempted = analytics?.totalAttempted || 0;
  const totalCorrect = analytics?.totalCorrect || 0;
  const totalWrong = analytics?.totalWrong || 0;
  const totalSkipped = analytics?.totalSkipped || 0;
  const overallAcc = (totalCorrect + totalWrong) > 0 ? Math.round(totalCorrect / (totalCorrect + totalWrong) * 100) : 0;
  const streak = calcStreak(sessions);
  const weakTopics = getWeakTopics(sessions);
  const last7 = sessions.slice(-7);
  const setStats = {};
  sessions.forEach(s => {
    if (!setStats[s.setTitle]) setStats[s.setTitle] = { correct:0, wrong:0, skipped:0, sessions:0, bestAcc:0 };
    const st = setStats[s.setTitle];
    st.correct += s.correct; st.wrong += s.wrong; st.skipped += s.skipped; st.sessions++;
    const acc = (s.correct+s.wrong)>0?Math.round(s.correct/(s.correct+s.wrong)*100):0;
    if (acc > st.bestAcc) st.bestAcc = acc;
  });
  const card = { background:"#161b22", borderRadius:14, padding:16, border:"1px solid #21262d", marginBottom:12 };

  return (
    <div style={{fontFamily:"'Segoe UI',sans-serif",minHeight:"100vh",background:"#0d1117",color:"#f1f5f9",padding:16,paddingBottom:32}}>
      {confirmReset && (
        <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#161b22",borderRadius:16,padding:24,maxWidth:320,width:"100%",border:"1px solid #21262d",textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>🗑️</div>
            <div style={{color:"#f1f5f9",fontSize:15,fontWeight:700,marginBottom:8}}>Reset all analytics?</div>
            <p style={{color:"#94a3b8",fontSize:13,marginBottom:20}}>This will permanently delete all session history.</p>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmReset(false)} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:11,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={()=>{setConfirmReset(false);onReset();}} style={{flex:1,background:"#f87171",color:"#0f172a",border:"none",borderRadius:10,padding:11,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Reset</button>
            </div>
          </div>
        </div>
      )}
      <div style={{maxWidth:600,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,paddingTop:8}}>
          <div>
            <h1 style={{fontSize:20,margin:"0 0 2px"}}>📊 Study Analytics</h1>
            <p style={{color:"#64748b",fontSize:12,margin:0}}>{sessions.length} sessions recorded</p>
          </div>
          <div style={{display:"flex",gap:8}}>
            {sessions.length > 0 && <button onClick={()=>setConfirmReset(true)} style={{background:"#2d0a0a",color:"#f87171",border:"1px solid #f8717130",borderRadius:10,padding:"8px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🗑 Reset</button>}
            <button onClick={onBack} style={{display:"inline-flex",alignItems:"center",gap:7,background:"#161b22",border:"1px solid #21262d",borderRadius:10,padding:"8px 14px 8px 10px",cursor:"pointer",fontFamily:"inherit"}}>
              <div style={{width:20,height:20,borderRadius:6,background:"#0d1117",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
              <span style={{color:"#64748b",fontSize:12,fontWeight:600}}>Back</span>
            </button>
          </div>
        </div>
        {sessions.length === 0 ? (
          <div style={{...card, textAlign:"center", padding:40}}>
            <div style={{fontSize:48,marginBottom:12}}>📈</div>
            <div style={{color:"#f1f5f9",fontSize:16,fontWeight:700,marginBottom:8}}>No sessions yet</div>
            <div style={{color:"#64748b",fontSize:13}}>Complete a quiz to start tracking your progress.</div>
          </div>
        ) : (
          <>
            <div style={{...card, background:"linear-gradient(135deg,#0d2a1f,#0f2d1a)", border:"1px solid #166534"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div>
                  <div style={{color:"#4ade80",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:6}}>🔥 STUDY STREAK</div>
                  <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                    <span style={{color:"#4ade80",fontSize:42,fontWeight:800,lineHeight:1}}>{streak.current}</span>
                    <span style={{color:"#86efac",fontSize:14,fontWeight:600}}>day{streak.current!==1?"s":""}</span>
                  </div>
                  <div style={{color:"#64748b",fontSize:11,marginTop:4}}>{streak.current===0?"Practice today to start your streak!":streak.current===1?"Keep going — practice again tomorrow!":"You're on a roll! Don't break it 💪"}</div>
                </div>
                <div style={{textAlign:"center",background:"#0d1117",borderRadius:12,padding:"12px 16px"}}>
                  <div style={{color:"#fbbf24",fontSize:22,fontWeight:700}}>{streak.best}</div>
                  <div style={{color:"#64748b",fontSize:10,marginTop:2}}>Best Streak</div>
                </div>
              </div>
              <div style={{marginTop:14}}>
                <div style={{color:"#4ade8066",fontSize:10,marginBottom:6}}>LAST 7 DAYS</div>
                <div style={{display:"flex",gap:6}}>
                  {Array.from({length:7}).map((_,i) => {
                    const d = new Date(); d.setDate(d.getDate()-(6-i));
                    const dateStr = d.toISOString().slice(0,10);
                    const practiced = sessions.some(s=>s.date===dateStr);
                    const isToday = dateStr===todayStr();
                    return (
                      <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                        <div style={{width:"100%",height:28,borderRadius:6,background:practiced?"#4ade80":isToday?"#21262d":"#161b22",border:isToday?"1px solid #4ade8044":"1px solid transparent"}}/>
                        <div style={{color:"#334155",fontSize:8}}>{["Su","Mo","Tu","We","Th","Fr","Sa"][d.getDay()]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {weakTopics.length > 0 && (
              <div style={{...card, background:"#1a0d0d", border:"1px solid #7f1d1d"}}>
                <div style={{color:"#f87171",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:10}}>⚠️ WEAK TOPICS</div>
                {weakTopics.map(({topic,acc,correct,wrong})=>(
                  <div key={topic} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <span style={{color:"#fca5a5",fontSize:13,fontWeight:600}}>{topic}</span>
                      <span style={{color:"#f87171",fontSize:13,fontWeight:700}}>{acc}%</span>
                    </div>
                    <div style={{background:"#2d1a1a",borderRadius:99,height:4,marginBottom:3}}>
                      <div style={{background:acc>=50?"#fbbf24":"#f87171",height:4,borderRadius:99,width:`${acc}%`}}/>
                    </div>
                    <div style={{color:"#64748b",fontSize:10}}>{correct} correct · {wrong} wrong</div>
                  </div>
                ))}
              </div>
            )}
            <div style={card}>
              <div style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:12}}>LIFETIME STATS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
                {[[totalAttempted+totalSkipped,"#60a5fa","Done"],[totalCorrect,"#4ade80","Correct"],[totalWrong,"#f87171","Wrong"]].map(([v,c,l])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:10,padding:12,textAlign:"center"}}><div style={{color:c,fontSize:22,fontWeight:700}}>{v}</div><div style={{color:"#64748b",fontSize:10,marginTop:2}}>{l}</div></div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[[overallAcc+"%","#a78bfa","Overall Accuracy"],[sessions.length,"#fbbf24","Sessions"]].map(([v,c,l])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:10,padding:12,textAlign:"center"}}><div style={{color:c,fontSize:22,fontWeight:700}}>{v}</div><div style={{color:"#64748b",fontSize:10,marginTop:2}}>{l}</div></div>
                ))}
              </div>
            </div>
            {last7.length > 1 && (
              <div style={card}>
                <div style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:14}}>RECENT SESSIONS</div>
                {sessions.slice(-10).reverse().map((s,i) => {
                  const acc=(s.correct+s.wrong)>0?Math.round(s.correct/(s.correct+s.wrong)*100):0;
                  const col=acc>=70?"#4ade80":acc>=50?"#fbbf24":"#f87171";
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid #1e293b"}}>
                      <div style={{minWidth:36,height:36,borderRadius:"50%",background:col+"22",color:col,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{acc}%</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{color:"#f1f5f9",fontSize:12,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.setTitle}</div>
                        <div style={{color:"#475569",fontSize:11}}>{s.date} · {s.correct}✓ {s.wrong}✗ · {fmtTime(s.duration)}</div>
                      </div>
                      <div style={{color:s.marks>=0?"#4ade80":"#f87171",fontSize:12,fontWeight:700,flexShrink:0}}>{s.marks>=0?"+":""}{s.marks}m</div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════════════════════
export default function App() {
  // ── Auth state ──────────────────────────────────────────────────────────────
  const [authMode, setAuthMode]       = useState(null); // null=loading, "auth"=show login screen, "guest"=guest, "cloud"=logged in
  const [user, setUser]               = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError]     = useState("");
  const [syncStatus, setSyncStatus]   = useState("idle"); // idle | syncing | synced | error
  const [bootReady, setBootReady]     = useState(false);  // gate: show spinner ~2s on mount while auth resolves

  // ── App state ───────────────────────────────────────────────────────────────
  const [appScreen, setAppScreen]     = useState("splash");
  const [lib, setLib]                 = useState(null);
  const [rev, setRev]                 = useState(null);
  const [analytics, setAnalytics]     = useState(null);
  const [srs, setSrs]                 = useState(null);
  const [folders, setFolders]         = useState(null);
  const [screen, setScreen]           = useState("library");
  const [showJson, setShowJson]       = useState(false);
  const [delKey, setDelKey]           = useState(null);
  const [renameKey, setRenameKey]     = useState(null);
  const [shareSet, setShareSet]       = useState(null);
  const [exportSet, setExportSet]     = useState(null);
  const [pendingImport, setPendingImport] = useState(null); // set decoded from a #import= share link
  const [showBackup, setShowBackup]   = useState(false);
  const [focusSort, setFocusSort]     = useState(false); // false=date order, true=grade worst-first
  const [activeFolderKey, setActiveFolderKey] = useState(null); // folder currently open (screen === "folder")
  const [showNewFolder, setShowNewFolder]     = useState(false);
  const [renameFolderKey, setRenameFolderKey] = useState(null);
  const [delFolderKey, setDelFolderKey]       = useState(null);
  const [moveSetKey, setMoveSetKey]           = useState(null); // set key currently being moved to a folder
  const [toast, setToast]             = useState("");
  const [activeKey, setActiveKey]     = useState(null);
  const [activeSet, setActiveSet]     = useState(null);
  const [topic, setTopic]             = useState("All Topics");
  const [mode, setMode]               = useState("full");
  const [timerSec, setTimerSec]       = useState(TIMER_DEFAULT);
  const [timerOn, setTimerOn]         = useState(true);
  const [shuffleOn, setShuffleOn]     = useState(true);
  const [qCount, setQCount]           = useState("All");
  const [qs, setQs]                   = useState([]);
  const [cur, setCur]                 = useState(0);
  const [ans, setAns]                 = useState({});
  const [bk, setBk]                   = useState({});
  const [revealed, setRevealed]       = useState(false);
  const [tLeft, setTLeft]             = useState(TIMER_DEFAULT);
  const [tTotal, setTTotal]           = useState(0);
  const [showPal, setShowPal]         = useState(false);
  const [showRst, setShowRst]         = useState(false);
  const [showFinish, setShowFinish]   = useState(false);
  const timerRef                      = useRef(null);
  const totalRef                      = useRef(null);

  // ── On mount: decide auth state ───────────────────────────────────────���─────
  useEffect(() => {
    const t = setTimeout(() => setBootReady(true), 2000);
    return () => clearTimeout(t);
  }, []);

  // ── Detect a shared set in the URL (#import=<code>) on first load ─────────────
  useEffect(() => {
    try {
      const m = (window.location.hash || "").match(/import=([^&]+)/);
      if (!m) return;
      const decoded = decodeSet(decodeURIComponent(m[1]));
      if (decoded && Array.isArray(decoded.questions) && decoded.questions.length) {
        setPendingImport(decoded);
      } else {
        clearImportHash();
      }
    } catch { /* ignore malformed links */ }
  }, []);

  // Remove the #import=... fragment from the address bar without reloading.
  const clearImportHash = () => {
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch {}
  };

  // Save a shared set straight to local storage (works regardless of auth state).
  const importSharedSet = () => {
    if (!pendingImport) return;
    const sd = { title: pendingImport.title || "Shared Set", questions: pendingImport.questions, savedAt: Date.now(), count: pendingImport.questions.length };
    const k = `s_${Date.now()}`;
    const current = loadS(LIB_KEY);
    const newLib = { ...current, [k]: sd };
    saveS(LIB_KEY, newLib);
    setLib(prev => (prev ? { ...prev, [k]: sd } : newLib));
    setPendingImport(null);
    clearImportHash();
    showToast(`✅ "${sd.title}" imported — ${sd.count} Qs`);
  };

  const cancelImport = () => { setPendingImport(null); clearImportHash(); };

  useEffect(() => {
    const stored = localStorage.getItem(GUEST_KEY);

    if (firebaseConfigured()) {
      initFirebase().then(async (fb) => {
        const { auth, getRedirectResult, onAuthStateChanged } = fb;
        let activeUid = null;

        // onAuthStateChanged is the reliable source of truth after a redirect:
        // it fires with the signed-in user even when getRedirectResult resolves
        // null (common on mobile browsers). It also restores existing sessions.
        // NOTE: after a redirect, this can fire once with null (before the
        // credential resolves) and again with the user — so we must NOT lock on
        // the first (null) callback. We guard by uid instead, which also avoids
        // re-running finalize on token-refresh fires for an already-active user.
        onAuthStateChanged(auth, async (u) => {
          if (u) {
            if (activeUid === u.uid) return; // already handled this user
            activeUid = u.uid;
            // finalizeSignIn enforces the email allowlist, sets the user,
            // writes localStorage to "cloud", loads cloud data, and shows the
            // logged-in banner on the splash screen.
            await finalizeSignIn(fb, u);
          } else {
            // No user (token expired, signed out, guest, or first visit).
            activeUid = null;
            setAuthMode("auth");
          }
        });

        // Still call getRedirectResult so any redirect error is surfaced and
        // the loading state is cleared once the redirect has been processed.
        try {
          await getRedirectResult(auth);
        } catch (e) {
          setAuthError(`Sign-in failed [redirect result]: ${e?.code || "unknown"} — ${e?.message || String(e)}`);
        } finally {
          setAuthLoading(false);
        }
      }).catch(() => setAuthMode("auth"));
      return;
    }

    // Firebase not configured — always show auth screen.
    setAuthMode("auth");
  }, []);

  // ── Android hardware back button (History API) ──────────────────────────────
  // Maps each in-app screen to the screen the back button should return to.
  // Screens not listed here (e.g. "library") are treated as the app root.
  const BACK_PARENT = { home: "library", analytics: "library", quiz: "library", result: "library", review: "result", folder: "library" };

  // Seed a base history entry on mount so the first back press is captured.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.history.replaceState({ haqRoot: true }, "");
  }, []);

  // Whenever the app is on a non-root screen, make sure exactly one "buffer"
  // history entry sits on top so a hardware back press triggers popstate
  // (navigating within the app) instead of closing it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (authMode === null || authMode === "auth") return;
    const isRoot = !BACK_PARENT[screen];
    const hasBuffer = window.history.state && window.history.state.haqBuffer;
    if (!isRoot && !hasBuffer) {
      window.history.pushState({ haqBuffer: true }, "");
    }
  }, [screen, authMode]);

  // Intercept back navigation: move to the logical parent screen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      setScreen(prev => BACK_PARENT[prev] || prev);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const enterGuestMode = () => {
    localStorage.setItem(GUEST_KEY, "guest");
    const l = loadS(LIB_KEY), r = loadS(REV_KEY), a = loadS(ANALYTICS_KEY), s = loadS(SRS_KEY), f = loadS(FOLDERS_KEY);
    setLib(l||{}); setRev(r||{}); setSrs(s||{}); setFolders(f||{});
    setAnalytics(a||{sessions:[],totalAttempted:0,totalCorrect:0,totalWrong:0,totalSkipped:0});
    setAuthMode("guest");
    setAppScreen("about");
  };

  const loadCloudData = async (uid) => {
    setSyncStatus("syncing");
    try {
      const [libData, revData, analyticsData, srsData, foldersData] = await Promise.all([
        cloudGet(uid, "library"),
        cloudGet(uid, "revision"),
        cloudGet(uid, "analytics"),
        cloudGet(uid, "srs"),
        cloudGet(uid, "folders"),
      ]);
      setLib(libData||{});
      setRev(revData||{});
      setSrs(srsData||{});
      setFolders(foldersData||{});
      // Analytics stored as single doc
      const aDoc = analyticsData["main"] || { sessions:[], totalAttempted:0, totalCorrect:0, totalWrong:0, totalSkipped:0 };
      setAnalytics(aDoc);
      setSyncStatus("synced");
    } catch (e) {
      console.error("Cloud load error:", e);
      setSyncStatus("error");
      // Fallback to local
      const l = loadS(LIB_KEY), r = loadS(REV_KEY), a = loadS(ANALYTICS_KEY), s = loadS(SRS_KEY), f = loadS(FOLDERS_KEY);
      setLib(l||{}); setRev(r||{}); setSrs(s||{}); setFolders(f||{});
      setAnalytics(a||{sessions:[],totalAttempted:0,totalCorrect:0,totalWrong:0,totalSkipped:0});
    }
  };

  // Shared post-sign-in handler — used by both the redirect result and session restore.
  const finalizeSignIn = async (fb, u) => {
    // ── Only allow your own account ──────────────────────────────────────────
    if (u.email !== "harshcapricorn777@gmail.com") {
      await fb.signOut(fb.auth);
      setUser(null);
      setAuthError("Cloud access is not available. Please use Guest Mode.");
      setAuthMode("auth");
      return;
    }
    setUser(u);
    localStorage.setItem(GUEST_KEY, "cloud");
    setAuthError("");
    await loadCloudData(u.uid);
    // Stay on the splash screen and show the confirmation banner.
    // The user enters the app via the "Continue" button (enterAppAfterSignIn).
    setAuthMode("auth");
    setAppScreen("splash");
  };

  // Called from the splash confirmation banner's "Continue" button.
  const enterAppAfterSignIn = () => {
    setAuthError("");
    setAuthMode("cloud");
    setAppScreen("about");
  };

  const handleGoogleSignIn = async () => {
    if (!firebaseConfigured()) { setAuthError("Firebase not configured. Add your config keys first."); return; }
    setAuthLoading(true); setAuthError("");
    try {
      const fb = await initFirebase();
      const provider = new fb.GoogleAuthProvider();
      // Keep the session across reloads/redirects (important on mobile).
      await fb.setPersistence(fb.auth, fb.browserLocalPersistence);
      try {
        // Primary flow: popup. onAuthStateChanged in the mount effect picks up
        // the resulting user and runs finalizeSignIn.
        await fb.signInWithPopup(fb.auth, provider);
      } catch (popupErr) {
        const code = popupErr?.code || "";
        // User deliberately cancelled / closed the popup: do NOT redirect.
        // Just reset back to the normal "Sign in with Google" button.
        const cancelled =
          code === "auth/popup-closed-by-user" ||
          code === "auth/cancelled-popup-request" ||
          code === "auth/user-cancelled";
        if (cancelled) {
          setAuthError("");
          return; // finally clears the loading state
        }
        // Popup is blocked/unsupported (common on mobile). Fall back to redirect;
        // the result is caught by getRedirectResult on next load.
        const popupUnsupported =
          code === "auth/popup-blocked" ||
          code === "auth/operation-not-supported-in-this-environment";
        if (popupUnsupported) {
          await fb.signInWithRedirect(fb.auth, provider);
          return; // browser navigates away
        }
        throw popupErr;
      }
    } catch (e) {
      setAuthError(`Sign-in failed: ${e?.code || "unknown"} — ${e?.message || String(e)}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      const fb = await initFirebase();
      await fb.signOut(fb.auth);
    } catch {}
    localStorage.removeItem(GUEST_KEY);
    setUser(null); setLib(null); setRev(null); setSrs(null); setAnalytics(null);
    setAuthMode("auth"); setScreen("library"); setAppScreen("splash");
  };

  const handleSwitchToCloud = () => {
    localStorage.removeItem(GUEST_KEY);
    setLib(null); setRev(null); setSrs(null); setAnalytics(null);
    setAuthMode("auth");
  };

  // ── Sync helpers ─────────────────────────────────────────────────────────────
  const isCloud = authMode === "cloud" && user;

  const persistLib = useCallback(async (l) => {
    setLib(l);
    if (isCloud) {
      // Save each set individually so we can delete cleanly
      setSyncStatus("syncing");
      try {
        await Promise.all(Object.entries(l).map(([k, v]) => cloudSave(user.uid, "library", k, v)));
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    } else { saveS(LIB_KEY, l); }
  }, [isCloud, user]);

  const persistRev = useCallback(async (r) => {
    setRev(r);
    if (isCloud) {
      setSyncStatus("syncing");
      try {
        await Promise.all(Object.entries(r).map(([k,v]) => cloudSave(user.uid, "revision", k, v)));
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    } else { saveS(REV_KEY, r); }
  }, [isCloud, user]);

  const persistAnalytics = useCallback(async (a) => {
    setAnalytics(a);
    if (isCloud) {
      setSyncStatus("syncing");
      try { await cloudSave(user.uid, "analytics", "main", a); setSyncStatus("synced"); }
      catch { setSyncStatus("error"); }
    } else { saveS(ANALYTICS_KEY, a); }
  }, [isCloud, user]);

  const persistSrs = useCallback(async (s) => {
    setSrs(s);
    if (isCloud) {
      setSyncStatus("syncing");
      try {
        await Promise.all(Object.entries(s).map(([k,v]) => cloudSave(user.uid, "srs", k, v)));
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    } else { saveS(SRS_KEY, s); }
  }, [isCloud, user]);

  const persistFolders = useCallback(async (f) => {
    setFolders(f);
    if (isCloud) {
      setSyncStatus("syncing");
      try {
        await Promise.all(Object.entries(f).map(([k,v]) => cloudSave(user.uid, "folders", k, v)));
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    } else { saveS(FOLDERS_KEY, f); }
  }, [isCloud, user]);

  const manualSync = () => { if (user) loadCloudData(user.uid); };

  // ── Keyboard shortcuts (quiz) ���───────────────────────────────────────────────
  useEffect(() => {
    if (screen !== "quiz") return;
    const handler = e => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight" && revealed) doNext();
      else if (e.key === "ArrowLeft") doPrev();
      else if (e.key === "b" || e.key === "B") setBk(p=>({...p,[qs[cur].id]:!p[qs[cur].id]}));
      else if (e.key === "s" || e.key === "S") doSkip();
      else if (["1","2","3","4"].includes(e.key) && !revealed) doSelect(parseInt(e.key)-1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [screen, cur, revealed, qs, ans, bk]);

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(""), 3500); };

  const getRevData = useCallback(key => {
    const d = (rev||{})[key] || {};
    return { bk: new Set(d.bookmarked||[]), inc: new Set(d.incorrect||[]), att: new Set(d.attempted||[]) };
  }, [rev]);

  const getSrsData = useCallback(key => (srs||{})[key] || {}, [srs]);

  const getSrsDueCount = useCallback(key => {
    const setData = getSrsData(key);
    const today = todayStr();
    return Object.values(setData).filter(q => q.due <= today).length;
  }, [getSrsData]);

  const updateSrsAfterQuiz = useCallback((key, ansData, bkSet) => {
    const setData = { ...(getSrsData(key)) };
    Object.entries(ansData).forEach(([qId, a]) => {
      const existing = setData[qId] || { rep: 0 };
      // Fix 2: a skipped question is treated the same as a WRONG answer for
      // scheduling — due again tomorrow, repetition count resets.
      const isCorrect = !a.skipped && !!a.correct;
      let { due, rep } = srsNextDate(existing.rep, isCorrect);
      // Fix 3: a bookmarked question resurfaces sooner — cap its due date at
      // a maximum of 3 days out, but never push it later than it already was.
      if (bkSet && bkSet.has(+qId)) {
        const cap = new Date(todayStr()); cap.setDate(cap.getDate() + 3);
        const capStr = cap.toISOString().slice(0,10);
        if (due > capStr) due = capStr;
      }
      setData[qId] = { due, rep };
    });
    persistSrs({ ...(srs||{}), [key]: setData });
  }, [srs, getSrsData, persistSrs]);

  const saveRevData = useCallback((key, newAns, newBk) => {
    const d = getRevData(key);
    Object.entries(newBk).forEach(([id,v]) => v ? d.bk.add(+id) : d.bk.delete(+id));
    Object.entries(newAns).forEach(([id,a]) => {
      if (a.selected !== null) d.att.add(+id);
      if (!a.correct && !a.skipped) d.inc.add(+id);
    });
    persistRev({...(rev||{}), [key]:{bookmarked:[...d.bk],incorrect:[...d.inc],attempted:[...d.att]}});
  }, [rev, getRevData, persistRev]);

  const saveSession = useCallback((ansData, duration, setTitle, topicStats) => {
    let correct=0, wrong=0, skipped=0;
    for (const a of Object.values(ansData)) {
      if (a.correct) correct++;
      else if (a.skipped) skipped++;
      else if (a.selected !== null) wrong++;
    }
    const marks = correct * MARKS_CORRECT + wrong * MARKS_WRONG;
    const session = { date: todayStr(), setTitle, correct, wrong, skipped, marks, duration, topicStats };
    const prev = analytics || { sessions:[],totalAttempted:0,totalCorrect:0,totalWrong:0,totalSkipped:0 };
    persistAnalytics({
      sessions: [...(prev.sessions||[]), session],
      totalAttempted: (prev.totalAttempted||0) + correct + wrong,
      totalCorrect: (prev.totalCorrect||0) + correct,
      totalWrong: (prev.totalWrong||0) + wrong,
      totalSkipped: (prev.totalSkipped||0) + skipped,
    });
  }, [analytics, persistAnalytics]);

  const handleSave = async (sd) => {
    const k = `s_${Date.now()}`;
    const newLib = {...(lib||{}), [k]:sd};
    await persistLib(newLib);
    if (isCloud) {
      // Also write this single set directly
      try { await cloudSave(user.uid, "library", k, sd); setSyncStatus("synced"); } catch { setSyncStatus("error"); }
    }
    setShowJson(false);
    showToast(`✅ "${sd.title}" saved — ${sd.count} Qs${isCloud?" · synced to cloud":""}`);
  };

  const handleDel = async () => {
    if (!delKey) return;
    const l={...(lib||{})}, r={...(rev||{})}, s={...(srs||{})};
    delete l[delKey]; delete r[delKey]; delete s[delKey];
    setLib(l); setRev(r); setSrs(s);
    if (isCloud) {
      setSyncStatus("syncing");
      try {
        await Promise.all([
          cloudDelete(user.uid, "library", delKey),
          cloudDelete(user.uid, "revision", delKey),
          cloudDelete(user.uid, "srs", delKey),
        ]);
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    } else { saveS(LIB_KEY,l); saveS(REV_KEY,r); saveS(SRS_KEY,s); }
    setDelKey(null);
    showToast("🗑️ Set deleted");
  };

  const handleRename = async (newTitle) => {
    if (!renameKey) return;
    const updated = { ...(lib||{}), [renameKey]: { ...(lib||{})[renameKey], title: newTitle } };
    await persistLib(updated);
    if (activeSet && activeKey === renameKey) setActiveSet(s=>({...s, title: newTitle}));
    setRenameKey(null);
    showToast(`✏️ Renamed to "${newTitle}"`);
  };

  // ── Folders ──────────────────────────────────────────────────────────────
  const handleCreateFolder = async (name) => {
    const k = `f_${Date.now()}`;
    const newFolders = { ...(folders||{}), [k]: { name, createdAt: Date.now() } };
    await persistFolders(newFolders);
    setShowNewFolder(false);
    showToast(`📁 Folder "${name}" created`);
  };

  const handleRenameFolder = async (newName) => {
    if (!renameFolderKey) return;
    const updated = { ...(folders||{}), [renameFolderKey]: { ...(folders||{})[renameFolderKey], name: newName } };
    await persistFolders(updated);
    setRenameFolderKey(null);
    showToast(`✏️ Folder renamed to "${newName}"`);
  };

  const handleDeleteFolder = async () => {
    if (!delFolderKey) return;
    // Permanently delete the folder AND every set inside it (plus their revision/SRS data).
    const keysInFolder = Object.entries(lib||{}).filter(([,sd]) => sd.folderId === delFolderKey).map(([k]) => k);
    const f = { ...(folders||{}) }; delete f[delFolderKey];
    const l = { ...(lib||{}) }, r = { ...(rev||{}) }, s = { ...(srs||{}) };
    keysInFolder.forEach(k => { delete l[k]; delete r[k]; delete s[k]; });
    setFolders(f); setLib(l); setRev(r); setSrs(s);
    if (isCloud) {
      setSyncStatus("syncing");
      try {
        await Promise.all([
          cloudDelete(user.uid, "folders", delFolderKey),
          ...keysInFolder.flatMap(k => [
            cloudDelete(user.uid, "library", k),
            cloudDelete(user.uid, "revision", k),
            cloudDelete(user.uid, "srs", k),
          ]),
        ]);
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    } else {
      saveS(FOLDERS_KEY, f); saveS(LIB_KEY, l); saveS(REV_KEY, r); saveS(SRS_KEY, s);
    }
    setDelFolderKey(null);
    setScreen("library");
    showToast(`🗑️ Folder and ${keysInFolder.length} set${keysInFolder.length!==1?"s":""} deleted`);
  };

  const handleMoveSet = async (key, folderId) => {
    const updated = { ...(lib||{}), [key]: { ...(lib||{})[key], folderId: folderId || null } };
    await persistLib(updated);
    setMoveSetKey(null);
    showToast(folderId ? `📁 Moved to "${(folders||{})[folderId]?.name}"` : "📁 Moved to Unfiled");
  };

  const rd = activeKey ? getRevData(activeKey) : { bk: new Set(), inc: new Set(), att: new Set() };
  const allTopics = activeSet ? ["All Topics", ...new Set(activeSet.questions.map(q=>q.topic||"General"))] : [];
  const colors = activeSet ? mkColors(activeSet.questions) : {};

  const startQuiz = useCallback(() => {
    if (!activeSet) return;
    let pool;
    const srsSetData = getSrsData(activeKey);
    const today = todayStr();
    if (mode === "bookmarked") pool = activeSet.questions.filter(q=>rd.bk.has(q.id));
    else if (mode === "incorrect") pool = activeSet.questions.filter(q=>rd.inc.has(q.id));
    else if (mode === "srs") pool = activeSet.questions.filter(q => { const d=srsSetData[q.id]; return !d||d.due<=today; });
    else pool = topic==="All Topics"?[...activeSet.questions]:activeSet.questions.filter(q=>q.topic===topic);
    if (shuffleOn) pool = shuffle(pool);
    if (qCount !== "All") pool = pool.slice(0, parseInt(qCount));
    const initBk = {};
    pool.forEach(q => { if(rd.bk.has(q.id)) initBk[q.id]=true; });
    setQs(pool); setCur(0); setAns({}); setBk(initBk);
    setRevealed(false); setTLeft(timerOn?timerSec:0); setTTotal(0); setShowPal(false);
    setScreen("quiz");
  }, [activeSet, activeKey, mode, topic, shuffleOn, qCount, rd, timerOn, timerSec, getSrsData]);

  const finish = useCallback((a, b) => {
    clearInterval(timerRef.current); clearInterval(totalRef.current);
    const topicStats = {};
    qs.forEach(q => {
      const t = q.topic||"General";
      if (!topicStats[t]) topicStats[t] = { correct:0, wrong:0, skipped:0 };
      const qa = a[q.id];
      if (qa?.correct) topicStats[t].correct++;
      else if (qa?.skipped) topicStats[t].skipped++;
      else if (qa&&qa.selected!==null) topicStats[t].wrong++;
    });
    saveRevData(activeKey, a, b);
    saveSession(a, tTotal, activeSet?.title||"Unknown", topicStats);
    const finalBk = getRevData(activeKey).bk;
    Object.entries(b).forEach(([id,v]) => v ? finalBk.add(+id) : finalBk.delete(+id));
    updateSrsAfterQuiz(activeKey, a, finalBk);
    setScreen("result");
  }, [activeKey, saveRevData, saveSession, updateSrsAfterQuiz, getRevData, tTotal, activeSet, qs]);

  useEffect(() => {
    if (screen!=="quiz"||!timerOn||revealed) return;
    clearInterval(timerRef.current);
    setTLeft(timerSec);
    timerRef.current = setInterval(() => {
      setTLeft(t => {
        if (t<=1) { clearInterval(timerRef.current); setAns(p=>({...p,[qs[cur]?.id]:{selected:null,correct:false,skipped:true}})); setRevealed(true); return 0; }
        return t-1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [screen, cur, timerOn, revealed, qs, timerSec]);

  useEffect(() => {
    if (screen!=="quiz") return;
    clearInterval(totalRef.current);
    totalRef.current = setInterval(()=>setTTotal(t=>t+1), 1000);
    return () => clearInterval(totalRef.current);
  }, [screen]);

  const doSelect = idx => {
    if (revealed) return;
    clearInterval(timerRef.current);
    setAns(p=>({...p,[qs[cur].id]:{selected:idx,correct:idx===qs[cur].answer,skipped:false}}));
    setRevealed(true);
  };
  const doSkip = () => {
    if (revealed) return;
    clearInterval(timerRef.current);
    setAns(p=>({...p,[qs[cur].id]:{selected:null,correct:false,skipped:true}}));
    setRevealed(true);
  };
  const goTo = idx => { setCur(idx); setRevealed(!!ans[qs[idx]?.id]); if(!ans[qs[idx]?.id]) setTLeft(timerSec); setShowPal(false); };
  const doNext = () => { const n=cur+1; if(n<qs.length){setCur(n);setRevealed(!!ans[qs[n]?.id]);if(!ans[qs[n]?.id])setTLeft(timerSec);}else finish(ans,bk); };
  const doPrev = () => { const p=cur-1; if(p>=0){setCur(p);setRevealed(!!ans[qs[p]?.id]);if(!ans[qs[p]?.id])setTLeft(timerSec);} };

  const correct   = Object.values(ans).filter(a=>a.correct).length;
  const wrong     = Object.values(ans).filter(a=>!a.correct&&!a.skipped&&a.selected!==null).length;
  const skipped   = Object.values(ans).filter(a=>a.skipped).length;
  const attempted = correct + wrong;
  const marks     = correct*MARKS_CORRECT + wrong*MARKS_WRONG;
  const maxMarks  = qs.length*MARKS_CORRECT;
  const acc       = attempted>0?Math.round(correct/attempted*100):0;
  const qStat     = q => { if(bk[q.id]) return "bookmarked"; const a=ans[q.id]; if(!a) return "unattempted"; if(a.skipped) return "skipped"; return a.correct?"correct":"wrong"; };
  const unattemptedCount = qs.length - Object.keys(ans).length;
  const sets = Object.entries(lib||{});
  // A set only counts as "in a folder" if that folder still exists — guards against stale folderId data.
  const isInFolder = (set) => !!(set.folderId && (folders||{})[set.folderId]);
  const unfiledSets = sets.filter(([,set]) => !isInFolder(set));
  const bg = { fontFamily:"'Segoe UI',sans-serif", minHeight:"100vh", background:"#0d1117", color:"#f1f5f9", padding:16 };

  // Shared set-card renderer — used on both the main Library screen (unfiled sets)
  // and inside an open Folder screen.
  const renderSetCard = ([key, set, d, gradeInfo]) => {
    const srsDue = getSrsDueCount(key);
    const topics = [...new Set((set.questions||[]).map(q=>q.topic||"General"))];
    const setSessions = (analytics?.sessions||[]).filter(s=>s.setTitle===set.title);
    const bestAcc = setSessions.length>0 ? Math.max(...setSessions.map(s=>(s.correct+s.wrong)>0?Math.round(s.correct/(s.correct+s.wrong)*100):0)) : null;
    return (
      <div key={key} style={{background:"#161b22",borderRadius:14,padding:"16px 18px",border:`1px solid ${gradeInfo.grade==="?"?"#21262d":gradeInfo.borderColor}`,marginBottom:10}}>
        <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            {/* Title row with grade badge */}
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
              <div style={{minWidth:28,height:28,borderRadius:8,background:gradeInfo.bg,border:`1.5px solid ${gradeInfo.borderColor}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:900,color:gradeInfo.color,flexShrink:0,letterSpacing:"-0.5px"}}>
                {gradeInfo.grade}
              </div>
              <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{set.title}</div>
            </div>
            <div style={{color:"#64748b",fontSize:11,marginBottom:8,paddingLeft:36}}>
              {set.count} Qs · {new Date(set.savedAt).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}
              {bestAcc !== null && <span style={{color:"#a78bfa",marginLeft:8}}>· Best {bestAcc}%</span>}
              {gradeInfo.grade !== "?" && <span style={{color:gradeInfo.color,marginLeft:8}}>· {gradeInfo.problemPct}% needs work</span>}
            </div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
              {d.bk.size>0 && <span style={{background:"#a78bfa22",color:"#a78bfa",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700}}>🔖 {d.bk.size}</span>}
              {d.inc.size>0 && <span style={{background:"#f8717122",color:"#f87171",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700}}>❌ {d.inc.size}</span>}
              {srsDue>0 && <span style={{background:"#60a5fa22",color:"#60a5fa",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700}}>🔁 {srsDue} due</span>}
              {setSessions.length>0 && <span style={{background:"#60a5fa11",color:"#475569",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:600}}>📊 {setSessions.length} sessions</span>}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
              {topics.slice(0,4).map(t=>(
                <span key={t} style={{background:"#0d1117",color:"#94a3b8",borderRadius:6,padding:"2px 7px",fontSize:9}}>{t}</span>
              ))}
              {topics.length>4 && <span style={{background:"#0d1117",color:"#64748b",borderRadius:6,padding:"2px 7px",fontSize:9}}>+{topics.length-4} more</span>}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
            <button onClick={()=>{setActiveSet(set);setActiveKey(key);setTopic("All Topics");setMode("full");setQCount("All");setScreen("home");}} style={{background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Practice →</button>
            <button onClick={()=>setRenameKey(key)} style={{background:"#161b22",color:"#60a5fa",border:"none",borderRadius:8,padding:"5px 14px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✏️ Rename</button>
            <button onClick={()=>setMoveSetKey(key)} style={{background:"#161b22",color:"#fbbf24",border:"none",borderRadius:8,padding:"5px 14px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>📁 Move</button>
            <button onClick={()=>setShareSet(set)} style={{background:"#161b22",color:"#38bdf8",border:"none",borderRadius:8,padding:"5px 14px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>🔗 Share Link</button>
            <button onClick={()=>setExportSet(set)} style={{background:"#161b22",color:"#2dd4bf",border:"1px solid #2dd4bf30",borderRadius:8,padding:"5px 14px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>⬇ Export</button>
            <button onClick={()=>setDelKey(key)} style={{background:"#161b22",color:"#f87171",border:"none",borderRadius:8,padding:"5px 14px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>🗑️ Delete</button>
          </div>
        </div>
      </div>
    );
  };

  // ── Import-from-link prompt (takes priority over everything) ─────────────────
  if (pendingImport) return (
    <ImportLinkModal data={pendingImport} onImport={importSharedSet} onCancel={cancelImport} />
  );

  // ── Loading ──────────────────────────────────────────────────────────────────
  // Show the spinner for at least ~2s on mount AND until auth state resolves.
  if (!bootReady || authMode === null) return (
    <div style={{...bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <div style={{width:20,height:20,border:"2px solid #2dd4bf",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <div style={{color:"#64748b",fontSize:13}}>Loading…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ── Splash — auth buttons live here now ──────────────────────────────────────
  if (authMode === "auth") return (
    <SplashScreen user={user} onGoogle={handleGoogleSignIn} onGuest={enterGuestMode} onContinue={enterAppAfterSignIn} onSignOut={handleSignOut} loading={authLoading} error={authError}/>
  );
  if (appScreen === "about") return <AboutScreen onStart={() => setAppScreen("app")} onHome={() => setAuthMode("auth")} />;

  // ── Wait for data ────────────────────────────────────────────��────────────────
  if (lib === null) return (
    <div style={{...bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <div style={{width:20,height:20,border:"2px solid #2dd4bf",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <div style={{color:"#64748b",fontSize:13}}>{isCloud?"Loading your cloud library…":"Loading…"}</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ── Analytics ───────────────────────────────────────────────────────��────────
  if (screen === "analytics") return (
    <AnalyticsScreen analytics={analytics||{}} lib={lib||{}} onBack={()=>setScreen("library")}
      onReset={()=>{ const empty={sessions:[],totalAttempted:0,totalCorrect:0,totalWrong:0,totalSkipped:0}; persistAnalytics(empty); showToast("🗑 Analytics reset"); setScreen("library"); }}/>
  );

  // ── Library ──────────────────────────────────────────────────────────────────
  if (screen === "library") {
    const streak = calcStreak(analytics?.sessions||[]);
    const totalSrsDue = sets.reduce((t,[key])=>t+getSrsDueCount(key), 0);
    const folderList = Object.entries(folders||{}).sort((a,b)=>(a[1].createdAt||0)-(b[1].createdAt||0));

    // Grade order for focus sort: D=0, C=1, B=2, A=3, S=4, ?=5
    const GRADE_ORDER = { D:0, C:1, B:2, A:3, S:4, "?":5 };
    const gradedSets = unfiledSets.map(([key, set]) => {
      const d = getRevData(key);
      const g = calcGrade(analytics?.sessions||[], set.title, d, set.questions?.length||set.count||0);
      return [key, set, d, g];
    });
    const sortedSets = focusSort
      ? [...gradedSets].sort((a,b) => (GRADE_ORDER[a[3].grade]??5) - (GRADE_ORDER[b[3].grade]??5))
      : gradedSets;
    return (
      <div style={bg}>
        {showJson && <JsonModal onSave={handleSave} onClose={()=>setShowJson(false)} folders={folders}/>}
        {showNewFolder && <FolderNameModal title="📁 New Folder" onSubmit={handleCreateFolder} onClose={()=>setShowNewFolder(false)}/>}
        {moveSetKey && <MoveToFolderModal folders={folders} currentFolderId={(lib||{})[moveSetKey]?.folderId} onMove={(fid)=>handleMoveSet(moveSetKey, fid)} onClose={()=>setMoveSetKey(null)}/>}
        {shareSet && <ShareModal set={shareSet} onClose={()=>setShareSet(null)}/>}
        {exportSet && <ExportModal set={exportSet} onClose={()=>setExportSet(null)}/>}
        {showBackup && <BackupModal lib={lib} rev={rev} analytics={analytics} srs={srs} folders={folders} isCloud={isCloud} user={user}
          onRestoreComplete={(merged)=>{
            // Data is already persisted (Firestore if cloud, localStorage if guest) inside doRestore.
            // Just reflect the merged result in React state directly — don't re-read localStorage,
            // since that isn't the source of truth in cloud mode.
            setLib(merged.library); setRev(merged.revision); setAnalytics(merged.analytics); setSrs(merged.srs); setFolders(merged.folders||{});
            showToast("✅ Library restored!");
          }}
          onClose={()=>setShowBackup(false)}/>}
        {renameKey && <RenameModal currentTitle={(lib||{})[renameKey]?.title||""} onRename={handleRename} onClose={()=>setRenameKey(null)}/>}
        {delKey && (
          <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
            <div style={{background:"#161b22",borderRadius:16,padding:24,maxWidth:320,width:"100%",border:"1px solid #21262d",textAlign:"center"}}>
              <div style={{fontSize:32,marginBottom:8}}>🗑️</div>
              <div style={{color:"#f1f5f9",fontSize:16,fontWeight:700,marginBottom:8}}>Delete this set?</div>
              <p style={{color:"#94a3b8",fontSize:13,marginBottom:20}}>"{(lib||{})[delKey]?.title}" will be permanently removed.</p>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setDelKey(null)} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
                <button onClick={handleDel} style={{flex:1,background:"#f87171",color:"#0f172a",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Delete</button>
              </div>
            </div>
          </div>
        )}
        {toast && <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:"#0d2a1f",border:"1px solid #166534",borderRadius:10,padding:"10px 18px",color:"#4ade80",fontSize:13,zIndex:300,whiteSpace:"nowrap",boxShadow:"0 4px 20px #00000060"}}>{toast}</div>}

        <div style={{maxWidth:580,margin:"0 auto"}}>
          {/* Auth banners */}
          {authMode==="guest" && <GuestBanner setCount={sets.length} onBackup={()=>setShowBackup(true)} onSignIn={handleSwitchToCloud}/>}

          {/* Header */}
          <div style={{background:"#161b22",borderRadius:16,padding:"18px 20px",marginBottom:12,border:"1px solid #21262d",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div
              onClick={()=>setAuthMode("auth")}
              role="button"
              tabIndex={0}
              aria-label="Go to home page"
              onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setAuthMode("auth"); } }}
              style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}
            >
              <div style={{width:46,height:46,borderRadius:12,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <img src="/icon-192.png" alt="HAQ PREP logo" width={46} height={46} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              </div>
              <div>
                <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9",letterSpacing:"-0.3px"}}>HAQ PREP</div>
                <div style={{color:"#64748b",fontSize:11,marginTop:1}}>{sets.length} set{sets.length!==1?"s":""} in library</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={()=>setAppScreen("about")} style={{display:"inline-flex",alignItems:"center",gap:7,background:"#161b22",border:"1px solid #21262d",borderRadius:10,padding:"8px 14px 8px 10px",cursor:"pointer",fontFamily:"inherit"}}>
                <div style={{width:20,height:20,borderRadius:6,background:"#0d1117",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
                <span style={{color:"#64748b",fontSize:12,fontWeight:600}}>Back</span>
              </button>
              <button onClick={()=>setScreen("analytics")} style={{background:"#161b22",border:"1px solid #21262d",borderRadius:12,padding:"10px 14px",color:"#a78bfa",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                <span style={{fontSize:18}}>📊</span><span style={{fontSize:10}}>Analytics</span>
              </button>
            </div>
          </div>

          {/* Streak + SRS bar */}
          {(analytics?.sessions||[]).length > 0 && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
              <div style={{background:"#0d2a1f",borderRadius:12,padding:"10px 14px",border:"1px solid #166534",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:22}}>🔥</span>
                <div>
                  <div style={{color:"#4ade80",fontSize:18,fontWeight:800,lineHeight:1}}>{streak.current} <span style={{fontSize:12,fontWeight:600}}>day streak</span></div>
                  <div style={{color:"#64748b",fontSize:10,marginTop:2}}>Best: {streak.best} days</div>
                </div>
              </div>
              <div style={{background:totalSrsDue>0?"#0f1a2d":"#0d1117",borderRadius:12,padding:"10px 14px",border:totalSrsDue>0?"1px solid #1e3a6e":"1px solid #21262d",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:22}}>🔁</span>
                <div>
                  <div style={{color:totalSrsDue>0?"#60a5fa":"#475569",fontSize:18,fontWeight:800,lineHeight:1}}>{totalSrsDue} <span style={{fontSize:12,fontWeight:600}}>due today</span></div>
                  <div style={{color:"#64748b",fontSize:10,marginTop:2}}>SRS review queue</div>
                </div>
              </div>
            </div>
          )}

          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <button onClick={()=>setShowJson(true)} style={{flex:1,background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:10,padding:"11px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Import JSON</button>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <button onClick={()=>setShowBackup(true)} style={{flex:1,background:"#161b22",color:"#2dd4bf",border:"1.5px solid #2dd4bf40",borderRadius:10,padding:"11px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>🗄️ Backup</button>
            <button onClick={()=>setShowNewFolder(true)} style={{flex:1,background:"#161b22",color:"#fbbf24",border:"1.5px solid #fbbf2440",borderRadius:10,padding:"11px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>📁 New Folder</button>
          </div>

          {folderList.length > 0 && (
            <div style={{marginBottom:16}}>
              <div style={{color:"#64748b",fontSize:11,fontWeight:700,marginBottom:8,paddingLeft:2,textTransform:"uppercase",letterSpacing:"0.5px"}}>Folders</div>
              {folderList.map(([fkey, folder]) => {
                const count = sets.filter(([,s]) => s.folderId === fkey).length;
                return (
                  <div key={fkey} onClick={()=>{setActiveFolderKey(fkey);setScreen("folder");}} role="button" tabIndex={0}
                    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setActiveFolderKey(fkey); setScreen("folder"); } }}
                    style={{background:"#161b22",borderRadius:14,padding:"14px 16px",border:"1px solid #21262d",marginBottom:8,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                      <span style={{fontSize:20}}>📁</span>
                      <div style={{minWidth:0}}>
                        <div style={{color:"#f1f5f9",fontSize:14,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{folder.name}</div>
                        <div style={{color:"#64748b",fontSize:11,marginTop:1}}>{count} set{count!==1?"s":""}</div>
                      </div>
                    </div>
                    <span style={{color:"#64748b",fontSize:18}}>›</span>
                  </div>
                );
              })}
            </div>
          )}

          {unfiledSets.length > 0 && (
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              {folderList.length > 0
                ? <div style={{color:"#64748b",fontSize:11,fontWeight:700,paddingLeft:2,textTransform:"uppercase",letterSpacing:"0.5px"}}>Unfiled</div>
                : <div/>}
              <button onClick={()=>setFocusSort(v=>!v)} style={{background:focusSort?"#f8717122":"#161b22",color:focusSort?"#f87171":"#64748b",border:`1px solid ${focusSort?"#f8717150":"#21262d"}`,borderRadius:8,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>
                {focusSort?"🎯 Focus Sort ON":"🎯 Focus Sort"}
              </button>
            </div>
          )}

          {sets.length === 0 && (
            <div style={{background:"#161b22",borderRadius:16,padding:40,border:"1px solid #21262d",textAlign:"center"}}>
              <div style={{fontSize:48,marginBottom:12}}>🧠</div>
              <h2 style={{fontSize:18,margin:"0 0 8px"}}>No sets yet</h2>
              <p style={{color:"#64748b",fontSize:13,margin:"0 0 20px"}}>Paste MCQ JSON to get started.</p>
              <button onClick={()=>setShowJson(true)} style={{background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:10,padding:"12px 20px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>📋 Paste JSON</button>
            </div>
          )}

          {sortedSets.map(renderSetCard)}
        </div>
      </div>
    );
  }

  // ── Folder ───────────────────────────────────────────────────────────────────
  if (screen === "folder") {
    const folder = (folders||{})[activeFolderKey];
    // Guard: folder was deleted elsewhere (e.g. another tab) — bounce back to library.
    if (!folder) { setScreen("library"); return null; }
    const folderSetEntries = sets.filter(([,s]) => s.folderId === activeFolderKey);
    const GRADE_ORDER = { D:0, C:1, B:2, A:3, S:4, "?":5 };
    const gradedFolderSets = folderSetEntries.map(([key, set]) => {
      const d = getRevData(key);
      const g = calcGrade(analytics?.sessions||[], set.title, d, set.questions?.length||set.count||0);
      return [key, set, d, g];
    });
    const sortedFolderSets = focusSort
      ? [...gradedFolderSets].sort((a,b) => (GRADE_ORDER[a[3].grade]??5) - (GRADE_ORDER[b[3].grade]??5))
      : gradedFolderSets;
    return (
      <div style={bg}>
        {showJson && <JsonModal onSave={handleSave} onClose={()=>setShowJson(false)} folders={folders} defaultFolderId={activeFolderKey}/>}
        {moveSetKey && <MoveToFolderModal folders={folders} currentFolderId={(lib||{})[moveSetKey]?.folderId} onMove={(fid)=>handleMoveSet(moveSetKey, fid)} onClose={()=>setMoveSetKey(null)}/>}
        {renameFolderKey && <FolderNameModal title="✏️ Rename Folder" currentValue={folder.name} onSubmit={handleRenameFolder} onClose={()=>setRenameFolderKey(null)}/>}
        {renameKey && <RenameModal currentTitle={(lib||{})[renameKey]?.title||""} onRename={handleRename} onClose={()=>setRenameKey(null)}/>}
        {shareSet && <ShareModal set={shareSet} onClose={()=>setShareSet(null)}/>}
        {exportSet && <ExportModal set={exportSet} onClose={()=>setExportSet(null)}/>}
        {delKey && (
          <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
            <div style={{background:"#161b22",borderRadius:16,padding:24,maxWidth:320,width:"100%",border:"1px solid #21262d",textAlign:"center"}}>
              <div style={{fontSize:32,marginBottom:8}}>🗑️</div>
              <div style={{color:"#f1f5f9",fontSize:16,fontWeight:700,marginBottom:8}}>Delete this set?</div>
              <p style={{color:"#94a3b8",fontSize:13,marginBottom:20}}>"{(lib||{})[delKey]?.title}" will be permanently removed.</p>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setDelKey(null)} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
                <button onClick={handleDel} style={{flex:1,background:"#f87171",color:"#0f172a",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Delete</button>
              </div>
            </div>
          </div>
        )}
        {delFolderKey && (
          <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
            <div style={{background:"#161b22",borderRadius:16,padding:24,maxWidth:340,width:"100%",border:"1px solid #21262d",textAlign:"center"}}>
              <div style={{fontSize:32,marginBottom:8}}>🗑️</div>
              <div style={{color:"#f1f5f9",fontSize:16,fontWeight:700,marginBottom:8}}>Delete "{folder.name}"?</div>
              <p style={{color:"#94a3b8",fontSize:13,marginBottom:20}}>This will permanently delete the folder <b>and all {folderSetEntries.length} set{folderSetEntries.length!==1?"s":""} inside it</b>. This can't be undone.</p>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setDelFolderKey(null)} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
                <button onClick={handleDeleteFolder} style={{flex:1,background:"#f87171",color:"#0f172a",border:"none",borderRadius:10,padding:12,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Delete</button>
              </div>
            </div>
          </div>
        )}
        {toast && <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:"#0d2a1f",border:"1px solid #166534",borderRadius:10,padding:"10px 18px",color:"#4ade80",fontSize:13,zIndex:300,whiteSpace:"nowrap",boxShadow:"0 4px 20px #00000060"}}>{toast}</div>}

        <div style={{maxWidth:580,margin:"0 auto"}}>
          <div style={{background:"#161b22",borderRadius:16,padding:"18px 20px",marginBottom:16,border:"1px solid #21262d"}}>
            <button onClick={()=>setScreen("library")} style={{display:"inline-flex",alignItems:"center",gap:7,background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"8px 14px 8px 10px",cursor:"pointer",fontFamily:"inherit",marginBottom:14}}>
              <div style={{width:20,height:20,borderRadius:6,background:"#161b22",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
              <span style={{color:"#64748b",fontSize:12,fontWeight:600}}>Library</span>
            </button>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
              <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                <span style={{fontSize:26}}>📁</span>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{folder.name}</div>
                  <div style={{color:"#64748b",fontSize:11,marginTop:1}}>{folderSetEntries.length} set{folderSetEntries.length!==1?"s":""}</div>
                </div>
              </div>
              <div style={{display:"flex",gap:6,flexShrink:0}}>
                <button onClick={()=>setRenameFolderKey(activeFolderKey)} style={{background:"#0d1117",color:"#60a5fa",border:"1px solid #21262d",borderRadius:8,padding:"7px 10px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✏️ Rename</button>
                <button onClick={()=>setDelFolderKey(activeFolderKey)} style={{background:"#0d1117",color:"#f87171",border:"1px solid #21262d",borderRadius:8,padding:"7px 10px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>🗑️ Delete</button>
              </div>
            </div>
          </div>

          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <button onClick={()=>setShowJson(true)} style={{flex:1,background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:10,padding:"11px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Import JSON into this folder</button>
          </div>

          {folderSetEntries.length > 0 && (
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
              <button onClick={()=>setFocusSort(v=>!v)} style={{background:focusSort?"#f8717122":"#161b22",color:focusSort?"#f87171":"#64748b",border:`1px solid ${focusSort?"#f8717150":"#21262d"}`,borderRadius:8,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>
                {focusSort?"🎯 Focus Sort ON":"🎯 Focus Sort"}
              </button>
            </div>
          )}

          {folderSetEntries.length === 0 && (
            <div style={{background:"#161b22",borderRadius:16,padding:40,border:"1px solid #21262d",textAlign:"center"}}>
              <div style={{fontSize:48,marginBottom:12}}>📁</div>
              <h2 style={{fontSize:18,margin:"0 0 8px"}}>This folder is empty</h2>
              <p style={{color:"#64748b",fontSize:13,margin:"0 0 20px"}}>Import a new set, or move an existing set here from the library.</p>
              <button onClick={()=>setShowJson(true)} style={{background:"linear-gradient(90deg,#0d9488,#2dd4bf)",color:"#0f172a",border:"none",borderRadius:10,padding:"12px 20px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>📋 Paste JSON</button>
            </div>
          )}

          {sortedFolderSets.map(renderSetCard)}
        </div>
      </div>
    );
  }

  // ── HOME ─────────────────────────────────────────────────────────────────────
  if (screen === "home" && activeSet) {
    const bCount = rd.bk.size, iCount = rd.inc.size;
    const srsDueCount = getSrsDueCount(activeKey);
    const poolSize = mode==="bookmarked"?bCount:mode==="incorrect"?iCount:mode==="srs"?srsDueCount:topic==="All Topics"?activeSet.count:activeSet.questions.filter(q=>q.topic===topic).length;
    const countOptions = ["10","20","30","All"].filter(c=>c==="All"||parseInt(c)<=poolSize);
    return (
      <div style={{...bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{background:"#161b22",borderRadius:20,padding:28,maxWidth:480,width:"100%",border:"1px solid #21262d"}}>
          <button onClick={()=>setScreen("library")} style={{display:"inline-flex",alignItems:"center",gap:7,background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:"8px 14px 8px 10px",cursor:"pointer",fontFamily:"inherit",marginBottom:18}}>
            <div style={{width:20,height:20,borderRadius:6,background:"#161b22",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
            <span style={{color:"#64748b",fontSize:12,fontWeight:600}}>Library</span>
          </button>
          <div style={{textAlign:"center",marginBottom:22}}>
            <div style={{fontSize:40,marginBottom:6}}>📋</div>
            <h2 style={{fontSize:19,margin:"0 0 4px",color:"#f1f5f9"}}>{activeSet.title}</h2>
            <p style={{color:"#64748b",fontSize:12,margin:0}}>{activeSet.count} Questions · CBT Mode</p>
          </div>
          <div style={{marginBottom:18}}>
            <label style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:"0.5px",display:"block",marginBottom:8}}>PRACTICE MODE</label>
            {[
              ["full","📋","Full Set",`All ${activeSet.count} questions`,"#4ade80",true],
              ["bookmarked","🔖","Bookmarked",`${bCount} questions`,"#a78bfa",bCount>0],
              ["incorrect","❌","Incorrect Only",`${iCount} to revise`,"#f87171",iCount>0],
              ["srs","🔁","SRS Review",srsDueCount>0?`${srsDueCount} due today`:"No cards due today","#60a5fa",srsDueCount>0],
            ].map(([m,ic,lb,sub,col,en])=>(
              <button key={m} onClick={()=>en&&setMode(m)} style={{width:"100%",background:mode===m?col+"22":"#0f172a",color:en?mode===m?col:"#94a3b8":"#475569",border:`1.5px solid ${mode===m?col:en?"#334155":"#1e293b"}`,borderRadius:12,padding:"11px 14px",textAlign:"left",cursor:en?"pointer":"not-allowed",display:"flex",alignItems:"center",gap:12,fontFamily:"inherit",marginBottom:7,opacity:en?1:0.5}}>
                <span style={{fontSize:18}}>{ic}</span>
                <div><div style={{fontSize:13,fontWeight:700}}>{lb}</div><div style={{fontSize:11,opacity:0.7}}>{sub}</div></div>
                {mode===m&&<span style={{marginLeft:"auto",color:col}}>✓</span>}
              </button>
            ))}
          </div>
          {mode==="srs" && (
            <div style={{background:"#0f1a2d",border:"1px solid #1e3a6e",borderRadius:10,padding:"10px 14px",marginBottom:18,color:"#93c5fd",fontSize:12,lineHeight:1.7}}>
              🔁 <b>How SRS works:</b> Questions return based on your performance. Correct → 1→3→7→14→30 days. Wrong → tomorrow.
            </div>
          )}
          {mode==="full" && (
            <div style={{marginBottom:18}}>
              <label style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:"0.5px",display:"block",marginBottom:8}}>FILTER BY TOPIC</label>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {allTopics.map(t=>{
                  const cnt=t==="All Topics"?activeSet.questions.length:activeSet.questions.filter(q=>q.topic===t).length;
                  return <button key={t} onClick={()=>setTopic(t)} style={{background:topic===t?"#4ade80":"#334155",color:topic===t?"#0f172a":"#94a3b8",border:"none",borderRadius:8,padding:"5px 10px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t==="All Topics"?`All (${cnt})`:`${t} (${cnt})`}</button>;
                })}
              </div>
            </div>
          )}
          {mode!=="srs" && (
            <div style={{marginBottom:18}}>
              <label style={{color:"#94a3b8",fontSize:11,fontWeight:700,letterSpacing:"0.5px",display:"block",marginBottom:8}}>NUMBER OF QUESTIONS</label>
              <div style={{display:"flex",gap:6}}>
                {countOptions.map(c=><button key={c} onClick={()=>setQCount(c)} style={{flex:1,background:qCount===c?"#60a5fa22":"#0f172a",color:qCount===c?"#60a5fa":"#64748b",border:`1.5px solid ${qCount===c?"#60a5fa":"#334155"}`,borderRadius:10,padding:"8px 4px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{c}</button>)}
              </div>
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
            <div>
              <div style={{display:"flex",gap:6,marginBottom:6}}>
                <button onClick={()=>setTimerOn(v=>!v)} style={{flex:1,background:timerOn?"#4ade8022":"#0f172a",color:timerOn?"#4ade80":"#64748b",border:`1.5px solid ${timerOn?"#4ade80":"#334155"}`,borderRadius:10,padding:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{timerOn?"⏱ Timer ON":"⏱ Timer OFF"}</button>
              </div>
              {timerOn && (
                <div style={{display:"flex",gap:4}}>
                  {[30,60,90,120].map(s=><button key={s} onClick={()=>setTimerSec(s)} style={{flex:1,background:timerSec===s?"#4ade8022":"#0f172a",color:timerSec===s?"#4ade80":"#475569",border:`1px solid ${timerSec===s?"#4ade80":"#334155"}`,borderRadius:6,padding:"4px 2px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{s}s</button>)}
                </div>
              )}
            </div>
            <button onClick={()=>setShuffleOn(v=>!v)} style={{background:shuffleOn?"#60a5fa22":"#0f172a",color:shuffleOn?"#60a5fa":"#64748b",border:`1.5px solid ${shuffleOn?"#60a5fa":"#334155"}`,borderRadius:10,padding:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{shuffleOn?"🔀 Shuffle ON":"🔀 Shuffle OFF"}</button>
          </div>
          <div style={{background:"#0d1117",borderRadius:10,padding:12,marginBottom:20,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,textAlign:"center"}}>
            {[["+4","#4ade80","Correct"],["-1","#f87171","Wrong"],["0","#fbbf24","Skipped"]].map(([v,c,l])=>(
              <div key={l}><div style={{color:c,fontSize:16,fontWeight:700}}>{v}</div><div style={{color:"#64748b",fontSize:10}}>{l}</div></div>
            ))}
          </div>
          <div style={{background:"#0d1117",borderRadius:10,padding:"8px 12px",marginBottom:16,color:"#475569",fontSize:10,textAlign:"center",lineHeight:1.7}}>
            ⌨️ Shortcuts: <span style={{color:"#64748b"}}>1-4</span> select · <span style={{color:"#64748b"}}>→</span> next · <span style={{color:"#64748b"}}>←</span> prev · <span style={{color:"#64748b"}}>S</span> skip · <span style={{color:"#64748b"}}>B</span> bookmark
          </div>
          <button onClick={startQuiz} disabled={poolSize===0} style={{background:poolSize===0?"#1e293b":"linear-gradient(90deg,#0d9488,#2dd4bf)",color:poolSize===0?"#475569":"#0f172a",border:"none",borderRadius:12,padding:16,fontSize:16,fontWeight:700,cursor:poolSize===0?"not-allowed":"pointer",width:"100%",fontFamily:"inherit"}}>
            {poolSize===0?"No questions available":"Start Quiz →"}
          </button>
        </div>
      </div>
    );
  }

  // ── RESULT ──────────────────────────────────────────────────────��────────────
  if (screen === "result") {
    const pct = maxMarks>0?Math.round(marks/maxMarks*100):0;
    const grade = pct>=80?"Excellent 🏆":pct>=60?"Good 👍":pct>=40?"Needs Work 📖":"Keep Revising 💪";
    const upd = getRevData(activeKey);
    // Grade before this session (using sessions excluding the last one)
    const allSessions = analytics?.sessions||[];
    const prevSessions = allSessions.slice(0, -1); // all except the just-saved session
    const prevGradeInfo = calcGrade(prevSessions, activeSet?.title||"", upd, activeSet?.questions?.length||0);
    const newGradeInfo  = calcGrade(allSessions,  activeSet?.title||"", upd, activeSet?.questions?.length||0);
    const gradeChanged  = prevGradeInfo.grade !== newGradeInfo.grade;
    const topicStats = {};
    qs.forEach(q => {
      const t=q.topic||"General";
      if(!topicStats[t]) topicStats[t]={correct:0,wrong:0,skipped:0,total:0};
      topicStats[t].total++;
      const a=ans[q.id];
      if(a?.correct) topicStats[t].correct++;
      else if(a?.skipped) topicStats[t].skipped++;
      else if(a&&!a.skipped&&a.selected!==null) topicStats[t].wrong++;
    });
    const srsScheduled = Object.entries(ans).filter(([,a])=>!a.skipped).length;
    return (
      <div style={{...bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{background:"#161b22",borderRadius:20,padding:28,maxWidth:480,width:"100%",border:"1px solid #21262d",maxHeight:"90vh",overflowY:"auto"}}>
          <div style={{textAlign:"center",marginBottom:20}}>
            <div style={{fontSize:44,marginBottom:6}}>🎯</div>
            <h2 style={{fontSize:20,margin:"0 0 4px",color:"#f1f5f9"}}>Quiz Complete!</h2>
            <p style={{color:"#64748b",fontSize:12,margin:0}}>Time: {fmtTime(tTotal)} · {activeSet?.title}</p>
            {isCloud && <div style={{color:"#4ade80",fontSize:11,marginTop:4}}>☁️ Results synced to cloud</div>}
          </div>
          <div style={{background:"#0d1117",borderRadius:12,padding:18,marginBottom:14,textAlign:"center"}}>
            <div style={{fontSize:40,fontWeight:700,color:marks>=0?"#4ade80":"#f87171"}}>{marks}/{maxMarks}</div>
            <div style={{color:"#94a3b8",fontSize:13,marginTop:4}}>Total Marks</div>
            <div style={{color:"#cbd5e1",fontSize:18,marginTop:6}}>{grade}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:14}}>
            {[["✓",correct,"#4ade80","Correct"],["✗",wrong,"#f87171","Wrong"],["→",skipped,"#fbbf24","Skipped"],["🎯",acc+"%","#60a5fa","Accuracy"]].map(([ic,v,c,l])=>(
              <div key={l} style={{background:"#0d1117",borderRadius:10,padding:10,textAlign:"center"}}><div style={{color:c,fontSize:16,fontWeight:700}}>{v}</div><div style={{color:"#64748b",fontSize:9,marginTop:2}}>{l}</div></div>
            ))}
          </div>
          {srsScheduled>0 && (
            <div style={{background:"#0f1a2d",border:"1px solid #1e3a6e",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:20}}>🔁</span>
              <div><div style={{color:"#60a5fa",fontSize:12,fontWeight:700}}>SRS Updated</div><div style={{color:"#475569",fontSize:11}}>{srsScheduled} questions scheduled for future review.</div></div>
            </div>
          )}
          {/* ── Grade Updated Card ── */}
          <div style={{background:newGradeInfo.bg,border:`1.5px solid ${newGradeInfo.borderColor}`,borderRadius:12,padding:"12px 14px",marginBottom:14}}>
            <div style={{color:newGradeInfo.color,fontSize:9,fontWeight:800,letterSpacing:1,marginBottom:8}}>📊 SET GRADE</div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              {gradeChanged && prevGradeInfo.grade !== "?" && (
                <>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#64748b",marginBottom:4}}>BEFORE</div>
                    <div style={{width:36,height:36,borderRadius:9,background:prevGradeInfo.bg,border:`1.5px solid ${prevGradeInfo.borderColor}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:prevGradeInfo.color}}>{prevGradeInfo.grade}</div>
                  </div>
                  <div style={{flex:1,textAlign:"center",color:"#64748b",fontSize:16}}>→</div>
                </>
              )}
              <div style={{textAlign:"center"}}>
                {gradeChanged && <div style={{fontSize:9,color:newGradeInfo.color,fontWeight:700,marginBottom:4}}>NOW</div>}
                <div style={{width:36,height:36,borderRadius:9,background:newGradeInfo.bg,border:`1.5px solid ${newGradeInfo.borderColor}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:newGradeInfo.color}}>{newGradeInfo.grade}</div>
              </div>
              <div style={{flex:1,fontSize:11,color:"#94a3b8",lineHeight:1.5}}>
                {gradeChanged && prevGradeInfo.grade !== "?"
                  ? <span style={{color:newGradeInfo.color,fontWeight:700}}>{`${prevGradeInfo.grade} → ${newGradeInfo.grade}`} Grade!</span>
                  : <span style={{fontWeight:700,color:newGradeInfo.color}}>Grade {newGradeInfo.grade}</span>
                }
              </div>
            </div>
            <div style={{marginTop:8,background:"#0d1117",borderRadius:7,padding:"6px 9px",fontSize:10,color:"#64748b",lineHeight:1.6}}>
              💡 {gradeNextTip(newGradeInfo.grade, newGradeInfo.problemPct)}
            </div>
          </div>
          {Object.keys(topicStats).length>1 && (
            <div style={{background:"#0d1117",borderRadius:12,padding:14,marginBottom:14}}>
              <div style={{color:"#94a3b8",fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:10}}>TOPIC BREAKDOWN</div>
              {Object.entries(topicStats).map(([t,st])=>{
                const tAcc=(st.correct+st.wrong)>0?Math.round(st.correct/(st.correct+st.wrong)*100):0;
                const col=tAcc>=70?"#4ade80":tAcc>=50?"#fbbf24":"#f87171";
                return (
                  <div key={t} style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{color:"#cbd5e1",fontSize:11,fontWeight:600}}>{t}</span>
                      <span style={{color:col,fontSize:11,fontWeight:700}}>{st.correct}/{st.total} · {tAcc}%</span>
                    </div>
                    <div style={{background:"#161b22",borderRadius:99,height:3}}>
                      <div style={{background:col,height:3,borderRadius:99,width:`${(st.correct/st.total)*100}%`}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{background:"#0d1117",borderRadius:12,padding:12,marginBottom:14,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,textAlign:"center"}}>
            <div><div style={{color:"#a78bfa",fontSize:16,fontWeight:700}}>{upd.bk.size}</div><div style={{color:"#64748b",fontSize:10}}>🔖 Bookmarked</div></div>
            <div><div style={{color:"#f87171",fontSize:16,fontWeight:700}}>{upd.inc.size}</div><div style={{color:"#64748b",fontSize:10}}>❌ Incorrect</div></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <button onClick={()=>setScreen("review")} style={{background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:12,padding:13,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>📋 Review</button>
            <button onClick={()=>setScreen("home")} style={{background:"#4ade80",color:"#0f172a",border:"none",borderRadius:12,padding:13,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🔄 Retry</button>
          </div>
          <button onClick={()=>setScreen("library")} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:7,background:"#161b22",border:"1px solid #21262d",borderRadius:12,padding:"11px 0",fontSize:12,fontWeight:600,cursor:"pointer",width:"100%",fontFamily:"inherit"}}>
            <div style={{width:20,height:20,borderRadius:6,background:"#0d1117",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
            <span style={{color:"#64748b"}}>Library</span>
          </button>
        </div>
      </div>
    );
  }

  // ── REVIEW ───────────────────────────────────────────────────────────────────
  if (screen === "review") {
    const bQs = qs.filter(q=>bk[q.id]);
    const wQs = qs.filter(q=>{const a=ans[q.id];return a&&!a.correct&&!a.skipped;});
    return (
      <div style={bg}>
        <div style={{maxWidth:720,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
            <h2 style={{fontSize:17,margin:0}}>📋 Review</h2>
            <button onClick={()=>setScreen("result")} style={{display:"inline-flex",alignItems:"center",gap:7,background:"#161b22",border:"1px solid #21262d",borderRadius:10,padding:"8px 14px 8px 10px",cursor:"pointer",fontFamily:"inherit"}}>
              <div style={{width:20,height:20,borderRadius:6,background:"#0d1117",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:14,lineHeight:1}}>‹</div>
              <span style={{color:"#64748b",fontSize:12,fontWeight:600}}>Back</span>
            </button>
          </div>
          {bQs.length>0 && <div style={{marginBottom:20}}><div style={{color:"#a78bfa",fontSize:12,fontWeight:700,marginBottom:10}}>🔖 BOOKMARKED ({bQs.length})</div>{bQs.map(q=><ReviewCard key={q.id} q={q} a={ans[q.id]}/>)}</div>}
          {wQs.length>0 && <div style={{marginBottom:20}}><div style={{color:"#f87171",fontSize:12,fontWeight:700,marginBottom:10}}>❌ INCORRECT ({wQs.length})</div>{wQs.map(q=><ReviewCard key={q.id} q={q} a={ans[q.id]}/>)}</div>}
          {bQs.length===0&&wQs.length===0 && <div style={{background:"#0d2a1f",borderRadius:12,padding:20,textAlign:"center",marginBottom:20,border:"1px solid #166534"}}><div style={{fontSize:32,marginBottom:8}}>🏆</div><div style={{color:"#4ade80",fontSize:14,fontWeight:700}}>Perfect! No bookmarks or incorrect answers.</div></div>}
          <div><div style={{color:"#4ade80",fontSize:12,fontWeight:700,marginBottom:10}}>📝 ALL ({qs.length})</div>{qs.map(q=><ReviewCard key={q.id} q={q} a={ans[q.id]}/>)}</div>
        </div>
      </div>
    );
  }

  // ── QUIZ ─────────────────────────────────────────────────────────────────────
  const q = qs[cur];
  if (!q) return null;
  const tCol = colors[q.topic]||"#4ade80";
  const qa = ans[q.id];
  const tPct = timerOn?(tLeft/timerSec)*100:100;
  const tClr = tLeft>timerSec*0.33?"#4ade80":tLeft>timerSec*0.11?"#fbbf24":"#f87171";
  const isLast = cur===qs.length-1;
  const handleFinishClick = () => { const unatt=qs.filter(qq=>!ans[qq.id]).length; if(unatt>0) setShowFinish(true); else finish(ans,bk); };

  return (
    <div style={bg}>
      {showRst && (
        <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#161b22",borderRadius:16,padding:24,maxWidth:300,width:"90%",border:"1px solid #21262d",textAlign:"center"}}>
            <div style={{color:"#f1f5f9",fontSize:15,fontWeight:700,marginBottom:8}}>Reset Quiz?</div>
            <p style={{color:"#94a3b8",fontSize:13,marginBottom:18}}>All progress will be lost.</p>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setShowRst(false)} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:11,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={()=>{setShowRst(false);startQuiz();}} style={{flex:1,background:"#f87171",color:"#0f172a",border:"none",borderRadius:10,padding:11,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Reset</button>
            </div>
          </div>
        </div>
      )}
      {showFinish && (
        <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#161b22",borderRadius:16,padding:24,maxWidth:300,width:"90%",border:"1px solid #fbbf2466",textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>⚠️</div>
            <div style={{color:"#f1f5f9",fontSize:15,fontWeight:700,marginBottom:8}}>Submit Quiz?</div>
            <p style={{color:"#fbbf24",fontSize:13,marginBottom:18}}>{unattemptedCount} question{unattemptedCount!==1?"s":""} unattempted. Submit anyway?</p>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setShowFinish(false)} style={{flex:1,background:"#161b22",color:"#f1f5f9",border:"none",borderRadius:10,padding:11,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Go Back</button>
              <button onClick={()=>{setShowFinish(false);finish(ans,bk);}} style={{flex:1,background:"#fbbf24",color:"#0f172a",border:"none",borderRadius:10,padding:11,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Submit</button>
            </div>
          </div>
        </div>
      )}
      {showPal && (
        <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={()=>setShowPal(false)}>
          <div style={{background:"#161b22",borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxWidth:720,border:"1px solid #21262d",maxHeight:"70vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{color:"#f1f5f9",fontSize:14,fontWeight:700}}>Question Palette</div>
              <button onClick={()=>setShowPal(false)} style={{background:"#161b22",color:"#94a3b8",border:"none",borderRadius:8,padding:"5px 10px",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Close</button>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
              {[["#4ade80","Correct"],["#f87171","Wrong"],["#fbbf24","Skipped"],["#a78bfa","Bookmarked"],["#334155","Not visited"]].map(([c,l])=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:8,height:8,borderRadius:"50%",background:c}}/><span style={{color:"#94a3b8",fontSize:10}}>{l}</span></div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:6}}>
              {qs.map((qq,i)=>{
                const st=qStat(qq);
                return <button key={qq.id} onClick={()=>goTo(i)} style={{background:STAT_COLORS[st],color:st==="unattempted"?"#94a3b8":"#0f172a",border:i===cur?"2px solid #f1f5f9":"2px solid transparent",borderRadius:8,padding:"7px 4px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{i+1}</button>;
              })}
            </div>
          </div>
        </div>
      )}
      <div style={{maxWidth:720,margin:"0 auto"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",alignItems:"center",marginBottom:10,gap:8}}>
          <div style={{display:"flex",gap:5}}>
            <button onClick={()=>setShowPal(true)} style={{background:"#161b22",color:"#94a3b8",border:"1px solid #21262d",borderRadius:8,padding:"5px 9px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>⊞ {cur+1}/{qs.length}</button>
            <button onClick={()=>setShowRst(true)} style={{background:"#161b22",color:"#f87171",border:"1px solid #21262d",borderRadius:8,padding:"5px 9px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>↺</button>
            <button onClick={handleFinishClick} style={{background:"#161b22",color:"#fbbf24",border:"1px solid #21262d",borderRadius:8,padding:"5px 9px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>🏁</button>
          </div>
          <div style={{textAlign:"center"}}>
            <div style={{color:"#64748b",fontSize:9,letterSpacing:1}}>ELAPSED</div>
            <div style={{color:"#94a3b8",fontSize:13,fontWeight:700}}>{fmtTime(tTotal)}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{color:marks>=0?"#4ade80":"#f87171",fontSize:13,fontWeight:700}}>{marks>=0?"+":""}{marks}m</div>
            <div style={{color:"#64748b",fontSize:9}}>Acc: {acc}%</div>
          </div>
        </div>
        <div style={{background:"#161b22",borderRadius:99,height:3,marginBottom:5}}>
          <div style={{background:tCol,height:3,borderRadius:99,width:`${(cur/qs.length)*100}%`}}/>
        </div>
        {timerOn&&!revealed && (
          <div style={{background:"#161b22",borderRadius:99,height:3,marginBottom:10}}>
            <div style={{background:tClr,height:3,borderRadius:99,width:`${tPct}%`,transition:"width 1s linear"}}/>
          </div>
        )}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            <span style={{background:tCol+"22",color:tCol,padding:"2px 9px",borderRadius:99,fontSize:9,fontWeight:700}}>{q.topic}</span>
            {mode==="srs"&&<span style={{background:"#60a5fa22",color:"#60a5fa",padding:"2px 9px",borderRadius:99,fontSize:9,fontWeight:700}}>🔁 SRS</span>}
            {q.type==="ar"&&<span style={{background:"#f472b622",color:"#f472b6",padding:"2px 9px",borderRadius:99,fontSize:9,fontWeight:700}}>A/R</span>}
            {q.type==="stmt"&&<span style={{background:"#60a5fa22",color:"#60a5fa",padding:"2px 9px",borderRadius:99,fontSize:9,fontWeight:700}}>Statement</span>}
            {q.type==="match"&&<span style={{background:"#fbbf2422",color:"#fbbf24",padding:"2px 9px",borderRadius:99,fontSize:9,fontWeight:700}}>Matching</span>}
            {q.type==="num"&&<span style={{background:"#34d39922",color:"#34d399",padding:"2px 9px",borderRadius:99,fontSize:9,fontWeight:700}}>Numerical</span>}
          </div>
          {timerOn&&!revealed && <div style={{color:tClr,fontSize:15,fontWeight:700}}>{fmtTime(tLeft)}</div>}
        </div>
        <div style={{background:"#161b22",borderRadius:16,padding:18,marginBottom:10,border:"1px solid #21262d",position:"relative"}}>
          <button onClick={()=>setBk(p=>({...p,[q.id]:!p[q.id]}))} style={{position:"absolute",top:10,right:10,background:"none",border:"none",fontSize:17,cursor:"pointer",opacity:bk[q.id]?1:0.3}}>🔖</button>
          <p style={{color:"#f1f5f9",fontSize:14,lineHeight:1.75,margin:0,whiteSpace:"pre-line",paddingRight:26}}>
            <span style={{color:"#64748b",fontSize:11,fontWeight:700}}>Q{cur+1}. </span>{q.q}
          </p>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:10}}>
          {q.options.map((opt,i)=>{
            let bg2="#1e293b",bc="#334155",cc="#cbd5e1",icon=null;
            if(revealed){
              if(i===q.answer){bg2="#022c22";bc="#4ade80";cc="#4ade80";icon="��";}
              else if(qa?.selected===i){bg2="#2d0a0a";bc="#f87171";cc="#f87171";icon="✗";}
              else{cc="#475569";}
            }
            return (
              <button key={i} onClick={()=>doSelect(i)} style={{background:bg2,border:`1.5px solid ${bc}`,borderRadius:12,padding:"11px 13px",textAlign:"left",cursor:revealed?"default":"pointer",color:cc,fontSize:13,lineHeight:1.5,display:"flex",alignItems:"flex-start",gap:10,fontFamily:"inherit"}}>
                <span style={{minWidth:20,height:20,borderRadius:"50%",background:revealed&&i===q.answer?"#4ade80":revealed&&qa?.selected===i?"#f87171":"#334155",color:revealed&&(i===q.answer||qa?.selected===i)?"#0f172a":"#64748b",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0,marginTop:1}}>
                  {icon||String.fromCharCode(65+i)}
                </span>
                <span>{opt}</span>
              </button>
            );
          })}
        </div>
        {revealed && (
          <div style={{background:qa?.correct?"#0f2922":"#2d0a0a",border:`1px solid ${qa?.correct?"#166534":"#7f1d1d"}`,borderRadius:12,padding:13,marginBottom:10}}>
            <div style={{color:qa?.correct?"#4ade80":"#fca5a5",fontSize:10,fontWeight:700,marginBottom:5}}>
              {qa?.skipped?"⏭ SKIPPED — ":qa?.correct?"✓ CORRECT — ":"✗ INCORRECT — "}💡 EXPLANATION
            </div>
            <p style={{color:qa?.correct?"#86efac":"#fca5a5",fontSize:12,lineHeight:1.6,margin:0}}>{q.explanation||"No explanation provided."}</p>
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,marginBottom:12}}>
          <button onClick={doPrev} disabled={cur===0} style={{background:cur===0?"#1e293b":"#334155",color:cur===0?"#475569":"#f1f5f9",border:"none",borderRadius:10,padding:11,fontSize:12,fontWeight:600,cursor:cur===0?"not-allowed":"pointer",fontFamily:"inherit"}}>← Prev</button>
          <button onClick={doSkip} disabled={revealed} style={{background:revealed?"#1e293b":"#fbbf2422",color:revealed?"#475569":"#fbbf24",border:`1.5px solid ${revealed?"#1e293b":"#fbbf24"}`,borderRadius:10,padding:11,fontSize:12,fontWeight:700,cursor:revealed?"not-allowed":"pointer",fontFamily:"inherit"}}>⏭ Skip</button>
          <button onClick={doNext} disabled={!revealed} style={{background:!revealed?"#1e293b":isLast?"#4ade80":"#334155",color:!revealed?"#475569":isLast?"#0f172a":"#f1f5f9",border:"none",borderRadius:10,padding:11,fontSize:12,fontWeight:700,cursor:!revealed?"not-allowed":"pointer",fontFamily:"inherit"}}>{isLast?"Finish 🏁":"Next →"}</button>
        </div>
        <div style={{background:"#161b22",borderRadius:12,padding:10,display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:4,textAlign:"center",border:"1px solid #21262d"}}>
          {[["✓",correct,"#4ade80","Correct"],["✗",wrong,"#f87171","Wrong"],["→",skipped,"#fbbf24","Skip"],["🎯",acc+"%","#60a5fa","Acc"],["📝",marks,"#a78bfa","Marks"]].map(([ic,v,c,l])=>(
            <div key={l}><div style={{color:c,fontSize:13,fontWeight:700}}>{v}</div><div style={{color:"#475569",fontSize:9,marginTop:1}}>{l}</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}
