# HAQ PREP

**Study actively. Revise smartly.** An AI-powered CBT practice platform for competitive exam prep.

HAQ PREP turns static MCQ sets into an adaptive study system — tracking what you actually get wrong, generating fresh practice on weak concepts, and giving you an AI tutor that explains *why*, not just *what*.

🔗 **Live App:** [v0-harshanand-iasbhu.vercel.app](https://v0-harshanand-iasbhu.vercel.app)

---

## Screenshots

`[dashboard screenshot]` · `[quiz/CBT screen]` · `[AI tutor / doubt chat]`

---

## Problem

Most students preparing for MCQ-based exams (ICAR, NTA, and similar) rely on static PDFs and generic quiz apps. These don't tell you *why* you got something wrong, don't adapt to your actual weak areas, and give every student the same fixed set of questions no matter how they're performing. Revision becomes guesswork instead of a targeted plan.

## Solution

HAQ PREP treats every quiz attempt as data. It grades your performance per set, tracks weak topics automatically, resurfaces the questions you struggle with using spaced repetition, and uses AI to explain mistakes, answer follow-up doubts, and generate a revision sheet built specifically from your own performance — not a generic study guide.

---

## Core Features

- **CBT-style quiz simulation** — timed, exam-like practice environment
- **Custom S–D grading engine** — each set graded on the real share of attempted questions still needing review
- **Streak tracking** — current and best streaks to build consistent study habits
- **Spaced repetition (SRS)** — questions you get wrong resurface sooner
- **Bookmarking** — flag any question mid-quiz for targeted later review
- **AI-generated explanations** — deeper breakdown of *why* the correct answer is right and why your selected option was a common mistake
- **AI doubt chat** — ask follow-up questions on any specific question, with response depth that scales to the doubt's complexity
- **AI-generated similar questions** — after a wrong answer, generates a fresh question testing the same concept for instant reinforcement
- **Personalized revision sheets** — built from your real accuracy data, weak topics, and recently-missed questions
- **Folder organization** — group question sets, move/rename/manage them
- **Installable PWA** — works offline, installs to your home screen like a native app
- **Cloud sync** — Firebase-backed, with a guest mode that works fully offline first
- **Backup, restore, export & sharing** — merge-based restore (won't overwrite existing data), JSON export/import, shareable set links

---

## How Questions Get Into the App

HAQ PREP doesn't ship with a fixed question bank — it's the study *engine*, not a static question library. Question sets are generated separately (using an AI prompt/skill built specifically for structured MCQ output) and then imported into the app in JSON format via the built-in import feature. This keeps the app flexible: any subject, any exam, any custom question set can be loaded in, rather than being locked to whatever content ships with the app.

## System Architecture

- **Frontend:** Next.js (React) — single-page app experience with client-side state management for quiz sessions, analytics, and library data
- **Backend:** Next.js API routes handle all AI calls server-side — the Gemini API key never reaches the browser
- **AI layer:** Google Gemini API, called through four distinct actions — explanation generation, doubt-chat, personalized revision sheets, and on-the-fly similar-question generation — each with its own tailored system prompt
- **Data layer:** Firebase Firestore for authenticated users; local storage for guest mode, with a merge-based sync when a guest later signs in — no data loss on upgrade
- **Deployment:** Vercel, connected to GitHub for CI-based deploys on every merge to main

## Tech Stack

- Next.js (React)
- Firebase Firestore
- Google Gemini API
- Vercel
- Progressive Web App (custom service worker: network-first for navigation, stale-while-revalidate for assets)

---

## Engineering Challenges

- **Free-tier API limits:** Google's Gemini free tier caps daily requests. Built a two-layer rate limiter — a global daily cap to protect the shared quota, and a per-IP cap so no single user can exhaust it for everyone else.
- **Offline-first sync:** Guest users needed a fully working app with zero backend dependency, but also a clean upgrade path to cloud sync without losing local data — solved with a merge strategy on restore instead of overwrite.
- **State persistence across sessions:** Quiz progress, grading, and streaks all need to survive refreshes and device switches, without assuming the user is signed in.
- **Grading logic:** Designed a grading formula based on the percentage of *attempted* questions still needing review (not raw score), so partially-completed sets are graded fairly instead of misleadingly.

---

## Builder Note

I'm an Agriculture Science student at Banaras Hindu University — not a CS student, and I had no formal coding background before this project. I built HAQ PREP using AI-assisted development, primarily with Claude, to write the implementation code.

What I actually did myself: defined every feature and how it should work, designed the grading and revision logic, tested each build, debugged issues as they came up, managed git branching and merges, and handled the full deployment pipeline. The code was AI-generated; the product decisions, architecture direction, and iteration were mine.

I'm treating this as the starting point for learning to build real, working software — not a one-off.

---

## Local Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.local.example` to `.env.local` and add your Gemini API key ([get one free here](https://aistudio.google.com))
4. `npm run dev`

---

## Future Roadmap

- Shared/global leaderboards for competitive practice
- Support for subject-specific AI tutors beyond general MCQ explanation
- Expanded analytics: time-per-question, difficulty trends over time
- Community-contributed question sets

---

## Author

**Harsh Anand** — Agriculture Science Student, Banaras Hindu University
harshcapricorn777@gmail.com
