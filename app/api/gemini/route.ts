import { NextRequest, NextResponse } from "next/server";

// ════════════════════════════════════════════════════════════════════════
// GEMINI API ROUTE — server-side only. API key never reaches the browser.
//
// Setup:
// 1. Free key → https://aistudio.google.com → "Get API Key"
// 2. Local:   add GEMINI_API_KEY=your_key to .env.local
// 3. Vercel:  Project → Settings → Environment Variables → GEMINI_API_KEY
// ════════════════════════════════════════════════════════════════════════

// gemini-2.0-flash was deprecated/shut down (June 1, 2026). Using the
// current free-tier Flash model instead.
const MODEL   = "gemini-2.5-flash";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ── App-wide daily request cap ─────────────────────────────────────────────
// Google's free tier resets quota at midnight Pacific Time, so we track our
// own counter the same way and stay a safety margin under the real limit
// (currently ~1500 RPD for Flash) so the app never gets hit with a 429.
//
// NOTE: this counter lives in server memory. On a long-running Node server
// (e.g. bolt.host) it works as a real global cap. On serverless platforms
// (e.g. Vercel) each instance keeps its own counter, so the true ceiling
// could be a bit higher than DAILY_LIMIT if multiple instances spin up —
// it's a best-effort safety net, not a hard guarantee. For a hard guarantee
// you'd need a shared store (Firestore/Redis) instead of memory.
const DAILY_LIMIT = 1450;
let requestCount = 0;
let counterDay = "";

// ── Per-visitor daily cap ───────────────────────────────────────────────────
// Stops any single guest (or a script/bot) from eating the entire shared
// 1450/day pool and locking everyone else out. Same memory caveat as above —
// resets if the server restarts, and is per-instance on serverless hosts.
const PER_IP_DAILY_LIMIT = 40;
const ipCounts = new Map<string, { day: string; count: number }>();

function pacificDateStr() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
}

function checkAndIncrementDailyLimit() {
  const today = pacificDateStr();
  if (today !== counterDay) {
    counterDay = today;
    requestCount = 0;
  }
  if (requestCount >= DAILY_LIMIT) {
    return false;
  }
  requestCount++;
  return true;
}

function checkAndIncrementIpLimit(ip: string) {
  const today = pacificDateStr();
  const entry = ipCounts.get(ip);
  if (!entry || entry.day !== today) {
    ipCounts.set(ip, { day: today, count: 1 });
    return true;
  }
  if (entry.count >= PER_IP_DAILY_LIMIT) {
    return false;
  }
  entry.count++;
  return true;
}

function getClientIp(req: NextRequest) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

async function callGemini(messages: {role:string; parts:{text:string}[]}[], systemInstruction?: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set on the server.");

  const body: any = { contents: messages };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };

  const res = await fetch(`${API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini error (${res.status}): ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content.");
  return text;
}

export async function POST(req: NextRequest) {
  try {
    if (!checkAndIncrementDailyLimit()) {
      return NextResponse.json(
        { error: `Daily AI request limit (${DAILY_LIMIT}) reached. This resets at midnight Pacific Time. Try again later.` },
        { status: 429 }
      );
    }

    const ip = getClientIp(req);
    if (!checkAndIncrementIpLimit(ip)) {
      return NextResponse.json(
        { error: `You've reached today's AI usage limit (${PER_IP_DAILY_LIMIT} requests). This resets at midnight Pacific Time.` },
        { status: 429 }
      );
    }

    const { action, payload } = await req.json();

    // ── 1. EXPLAIN (first deep explanation for a question) ────────────────────
    if (action === "explain") {
      const { question, options, correctIndex, selectedIndex, existingExplanation, topic } = payload;
      const system = `You are a B.Sc. Agriculture exam tutor (ICAR JRF level). Be precise, exam-focused, and concise. Plain text only — no markdown headers, no bullet symbols.`;
      const prompt = `Explain this MCQ in more depth than the brief explanation already given. Max 120 words. Explain why the correct option is right AND why the student's selected wrong option is a common distractor/mistake.

Topic: ${topic || "General Agriculture"}
Question: ${question}
Options: ${options.map((o: string, i: number) => `${String.fromCharCode(65+i)}. ${o}`).join(" | ")}
Correct answer: ${String.fromCharCode(65+correctIndex)}
Student selected: ${selectedIndex != null ? String.fromCharCode(65+selectedIndex) : "(skipped/not selected)"}
Brief explanation already shown: ${existingExplanation || "(none)"}`;

      const text = await callGemini([{ role:"user", parts:[{text:prompt}] }], system);
      return NextResponse.json({ explanation: text.trim() });
    }

    // ── 2. DOUBT CHAT (follow-up Q&A on a question) ───────────────────────────
    if (action === "doubt") {
      const { question, options, correctIndex, topic, history, userMessage } = payload;
      const system = `You are a concise B.Sc. Agriculture tutor (ICAR JRF level). The student is asking follow-up doubts about a specific MCQ. Answer only what they ask. Max 100 words per reply. Plain text only — no markdown, no bullet symbols, no headers.`;

      // Build the conversation — first turn sets question context
      const contextMsg = `The MCQ under discussion:
Topic: ${topic || "General"}
Question: ${question}
Options: ${options.map((o: string, i: number) => `${String.fromCharCode(65+i)}. ${o}`).join(" | ")}
Correct answer: ${String.fromCharCode(65+correctIndex)}`;

      const messages: {role:string; parts:{text:string}[]}[] = [
        { role: "user", parts: [{ text: contextMsg }] },
        { role: "model", parts: [{ text: "Got it. Ask your doubt about this question." }] },
        ...(history || []).map((m: {role:string; text:string}) => ({
          role: m.role === "ai" ? "model" : "user",
          parts: [{ text: m.text }],
        })),
        { role: "user", parts: [{ text: userMessage }] },
      ];

      const text = await callGemini(messages, system);
      return NextResponse.json({ reply: text.trim() });
    }

    // ── 3. REVISION SHEET (personalized from real app data) ───────────────────
    if (action === "revision") {
      const { weakTopics, overallAcc, totalSessions, recentWrongSamples, bookmarkedSamples } = payload;

      const system = `You are a B.Sc. Agriculture exam strategist. Generate a personalized, exam-ready revision sheet. Plain text only. Use simple section labels like "WEAK TOPICS TO REVISE:", "KEY CONCEPTS TO REVIEW:", "QUICK FACTS TO MEMORIZE:", "EXAM STRATEGY:". No markdown symbols, no bullet points — write in short numbered lines or plain sentences within each section.`;

      const prompt = `Generate a personalized revision sheet for this student based on their real performance data.

Overall accuracy: ${overallAcc}%
Total sessions completed: ${totalSessions}
Weak topics (below 50% accuracy):
${weakTopics.map((t: any) => `- ${t.topic}: ${t.acc}% accuracy (${t.wrong} wrong, ${t.correct} correct)`).join("\n") || "None identified yet (need more sessions)"}

Sample of recently wrong questions:
${recentWrongSamples?.map((q: string, i: number) => `${i+1}. ${q}`).join("\n") || "Not available"}

Sample of bookmarked (flagged for review) questions:
${bookmarkedSamples?.map((q: string, i: number) => `${i+1}. ${q}`).join("\n") || "None bookmarked"}

Generate a focused revision sheet with: which weak topics to revise first and what specific sub-concepts to focus on within them, key facts likely to be tested based on the wrong questions pattern, and a short exam strategy note for this student's current level. Keep it practical, specific, and under 300 words.`;

      const text = await callGemini([{ role:"user", parts:[{text:prompt}] }], system);
      return NextResponse.json({ sheet: text.trim() });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Server error." }, { status: 500 });
  }
}
