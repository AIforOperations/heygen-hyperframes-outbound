"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  Cpu,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mail,
  Paperclip,
  Play,
  Search,
  Sparkles,
  Video,
  Wand2,
  X,
} from "lucide-react";
import { GALLERY, type GalleryEntry } from "@/lib/gallery";

function Linkedin({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20.452 20.452h-3.554v-5.569c0-1.328-.025-3.037-1.852-3.037-1.853 0-2.136 1.446-2.136 2.94v5.666H9.356V9h3.414v1.561h.046c.476-.9 1.637-1.852 3.37-1.852 3.602 0 4.266 2.37 4.266 5.456v6.287zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.066 2.063 2.063 0 1 1 2.063 2.066zM7.119 20.452H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .771 0 1.726v20.547C0 23.228.792 24 1.771 24h20.451C23.2 24 24 23.228 24 22.273V1.726C24 .771 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// ---------- Avatar type (loaded from /api/avatars) ----------
type AvatarCrop = {
  positionY: string;
  scale: number;
  originY: string;
};
type Avatar = {
  id: string;
  label: string;
  style: string;
  voiceId: string;
  voiceName: string;
  fallbackColor: string;
  crop: AvatarCrop;
  previewImageUrl: string | null;
  previewVideoUrl: string | null;
  heygenDefaultVoiceId: string | null;
  supportedEngines: ("avatar_v" | "avatar_iv")[];
};

const FALLBACK_AVATAR: Avatar = {
  id: "ari-fallback",
  label: "Ari",
  style: "Founder, LeadFlow",
  voiceId: "01f98ed43e6140349f47dbd37a416827",
  voiceName: "Cody (M)",
  fallbackColor: "#DC2626",
  crop: { positionY: "22%", scale: 1.0, originY: "30%" },
  previewImageUrl: null,
  previewVideoUrl: null,
  heygenDefaultVoiceId: null,
  supportedEngines: ["avatar_v"],
};

function initialsFromLabel(label: string): string {
  return label
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function AvatarThumb({
  avatar,
  size = 32,
}: {
  avatar: Avatar;
  size?: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!avatar.previewImageUrl && !imgFailed;
  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[0.7rem] font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: avatar.fallbackColor,
      }}
      aria-label={avatar.label}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatar.previewImageUrl!}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initialsFromLabel(avatar.label)}</span>
      )}
    </span>
  );
}

const VOICE_TEMPLATES = [
  { id: "vt_analyst", label: "Analyst", desc: "Numbers-first, calm" },
  { id: "vt_founder", label: "Founder", desc: "Conversational, warm" },
  { id: "vt_closer", label: "Closer", desc: "Direct, urgent" },
  { id: "vt_advisor", label: "Advisor", desc: "Helpful, patient" },
];

const PIPELINE_STEPS = [
  { id: "scrape", label: "Scrape profile + company", icon: Search, duration: 1800 },
  { id: "stat", label: "Find the angle", icon: Sparkles, duration: 1600 },
  { id: "script", label: "Write the script", icon: FileText, duration: 1700 },
  { id: "avatar", label: "Render Avatar V", icon: Cpu, duration: 2200 },
  { id: "compose", label: "Compose HyperFrames", icon: Wand2, duration: 1800 },
];

type StepStatus = "pending" | "active" | "done";

const PROMPT_LIMIT = 1200;

// ---------- Attachment limits (Claude API friendly) ----------
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB total
const MAX_FILES = 4;
const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
const ALLOWED_HINT = "PDF, PNG, JPG · 2 MB each · 5 MB total";

type Attachment = {
  id: string;
  file: File;
  previewUrl?: string;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  // ---------- Avatar list + selection ----------
  const [avatars, setAvatars] = useState<Avatar[]>([FALLBACK_AVATAR]);
  const [avatarsLoading, setAvatarsLoading] = useState(true);
  const [avatar, setAvatar] = useState<Avatar>(FALLBACK_AVATAR);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/avatars")
      .then((r) => r.json())
      .then((d: { avatars?: Avatar[] }) => {
        if (cancelled || !d.avatars?.length) return;
        setAvatars(d.avatars);
        setAvatar(d.avatars[0]);
      })
      .catch(() => {
        /* keep fallback */
      })
      .finally(() => {
        if (!cancelled) setAvatarsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close avatar dropdown on click outside or Escape
  useEffect(() => {
    if (!avatarOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!avatarRef.current?.contains(e.target as Node)) {
        setAvatarOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAvatarOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [avatarOpen]);

  const [voiceMode, setVoiceMode] = useState<"templates" | "custom">("templates");
  const [voiceTemplate, setVoiceTemplate] = useState(VOICE_TEMPLATES[1].id);
  const [voiceCustom, setVoiceCustom] = useState("");

  const [inputMode, setInputMode] = useState<"linkedin" | "company">("linkedin");
  const [inputValue, setInputValue] = useState("");
  const [senderCompany, setSenderCompany] = useState("");
  const [prompt, setPrompt] = useState("");

  // ---------- Attachments ----------
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const totalAttachedBytes = attachments.reduce((s, a) => s + a.file.size, 0);

  const handleFiles = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    setAttachError(null);
    const next: Attachment[] = [...attachments];
    const errors: string[] = [];
    let running = totalAttachedBytes;

    for (const file of Array.from(picked)) {
      if (next.length >= MAX_FILES) {
        errors.push(`Max ${MAX_FILES} files`);
        break;
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        errors.push(`${file.name}: unsupported type (PDF, PNG, JPG only)`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        errors.push(`${file.name}: ${formatBytes(file.size)} exceeds 2 MB cap`);
        continue;
      }
      if (running + file.size > MAX_TOTAL_BYTES) {
        errors.push(`${file.name}: would exceed 5 MB total`);
        continue;
      }
      const previewUrl = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      next.push({
        id: `${file.name}-${file.size}-${Date.now()}`,
        file,
        previewUrl,
      });
      running += file.size;
    }

    setAttachments(next);
    if (errors.length) setAttachError(errors.join(" · "));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (id: string) => {
    setAttachments((curr) => {
      const item = curr.find((a) => a.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return curr.filter((a) => a.id !== id);
    });
    setAttachError(null);
  };

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [engine, setEngine] = useState<"avatar_iv" | "avatar_v">("avatar_v");

  // ---------- Pipeline state ----------
  const [running, setRunning] = useState(false);
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(
    PIPELINE_STEPS.map(() => "pending")
  );
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Latest job state from the polling loop. Used to render real-data
  // step summaries (lead name, script word count, render duration, etc.).
  type JobStateLite = {
    stage?: string;
    status?: string;
    lead?: {
      firstName?: string | null;
      fullName?: string | null;
      role?: string | null;
      company?: { name?: string | null; websiteUrl?: string | null } | null;
      headline?: string | null;
      website?: { heroText?: string | null } | null;
    } | null;
    scriptText?: string | null;
    wordCount?: number | null;
    estimatedSeconds?: number | null;
    heygenStatus?: string | null;
    heygenDuration?: number | null;
    heygenVideoUrl?: string | null;
    outputUrl?: string | null;
  };
  const [jobState, setJobState] = useState<JobStateLite | null>(null);

  // ---------- Gallery (dynamic) ----------
  const [galleryEntries, setGalleryEntries] = useState<GalleryEntry[]>(GALLERY);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/gallery")
      .then((r) => r.json())
      .then((d: { ok?: boolean; entries?: GalleryEntry[] }) => {
        if (cancelled || !d?.ok || !d.entries?.length) return;
        setGalleryEntries(d.entries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshGallery = () => {
    fetch("/api/gallery")
      .then((r) => r.json())
      .then((d: { ok?: boolean; entries?: GalleryEntry[] }) => {
        if (d?.ok && d.entries?.length) setGalleryEntries(d.entries);
      })
      .catch(() => {});
  };

  // ---------- Email capture ----------
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  // ---------- Generate handler ----------
  //
  // Async pipeline:
  //   POST /api/generate                  → returns { jobId, state }
  //                                          (scrape + script + heygen kickoff
  //                                          ran on the server, ~30-60s)
  //   GET  /api/generate?jobId=X          → poll every 7s until complete
  //                                          The poll that catches
  //                                          "HeyGen completed" also runs
  //                                          transcribe + compose + render
  //                                          inline (~40-50s).
  //
  // Backend stages → frontend pipeline step indices:
  //   scrape    → step 0 active
  //   script    → step 0 done, 1 done, 2 active
  //   heygen    → 0..2 done, 3 active
  //   transcribe / compose / render → 0..3 done, 4 active
  //   done      → all done
  const stageToSteps = (stage: string): StepStatus[] => {
    switch (stage) {
      case "scrape":
        return ["active", "pending", "pending", "pending", "pending"];
      case "script":
        return ["done", "done", "active", "pending", "pending"];
      case "heygen":
        return ["done", "done", "done", "active", "pending"];
      case "transcribe":
      case "compose":
      case "render":
        return ["done", "done", "done", "done", "active"];
      case "done":
        return ["done", "done", "done", "done", "done"];
      default:
        return PIPELINE_STEPS.map(() => "pending");
    }
  };

  const startGeneration = async () => {
    if (running) return;
    if (!inputValue.trim() || !prompt.trim() || !senderCompany.trim()) return;

    setRunning(true);
    setFinishedAt(null);
    setOutputUrl(null);
    setErrorMsg(null);
    setJobState(null);
    setStepStatuses(PIPELINE_STEPS.map(() => "pending"));

    try {
      const kind: "personUrl" | "companyUrl" | "companyName" =
        inputMode === "company"
          ? "companyName"
          : inputValue.includes("/company/")
            ? "companyUrl"
            : "personUrl";

      const tonality =
        voiceMode === "templates" ? voiceTemplate : voiceCustom.trim();

      const body = {
        input: { kind, value: inputValue.trim() },
        offer: prompt,
        senderName: avatar.label,
        senderCompany: senderCompany.trim() || undefined,
        tonality,
        avatarId: avatar.id,
        engine,
        lengthSeconds: 30,
      };

      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) {
        throw new Error(
          data?.message || data?.error || `POST failed (${r.status})`
        );
      }
      const jobId: string = data.jobId;
      setJobState(data.state);
      setStepStatuses(stageToSteps(data.state.stage));

      // Poll fast (3s) so each per-stage advance is visible. HeyGen render
      // dominates total wall time (~3-5 min on Avatar V for 30s output) —
      // most polls are quick reads of the heygen status. Cap at ~15 min total.
      const POLL_INTERVAL_MS = 3000;
      const MAX_POLLS = 300;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
        const pr = await fetch(`/api/generate?jobId=${encodeURIComponent(jobId)}`);
        const pd = await pr.json();
        if (!pr.ok || !pd?.ok) {
          throw new Error(
            pd?.message || pd?.error || `Poll failed (${pr.status})`
          );
        }
        const state = pd.state;
        setJobState(state);
        setStepStatuses(stageToSteps(state.stage));
        if (state.status === "complete" && state.outputUrl) {
          setOutputUrl(state.outputUrl);
          setFinishedAt(Date.now());
          refreshGallery();
          return;
        }
        if (state.status === "failed") {
          throw new Error(state.error || "Pipeline failed");
        }
      }
      throw new Error("Pipeline timed out (>15 min). Check /api/generate?jobId for status.");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setRunning(false);
    }
  };

  // Cmd+Enter / Ctrl+Enter to fire generation from anywhere on the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        startGeneration();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, prompt, running]);

  const submitEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setEmailSent(true);
  };

  const completedCount = stepStatuses.filter((s) => s === "done").length;
  const progressPercent = (completedCount / PIPELINE_STEPS.length) * 100;

  const voiceReady =
    voiceMode === "templates" ? !!voiceTemplate : voiceCustom.trim().length > 0;

  const canGenerate =
    !running &&
    inputValue.trim().length > 0 &&
    senderCompany.trim().length > 0 &&
    prompt.trim().length > 0 &&
    voiceReady;

  const disabledReason = running
    ? "Running…"
    : !inputValue.trim()
      ? `Add a ${inputMode === "linkedin" ? "LinkedIn URL" : "company name"} first`
      : !senderCompany.trim()
        ? "Add your company name"
        : !voiceReady
          ? "Describe the brand voice"
          : !prompt.trim()
            ? "Add the purpose of the video"
            : "";

  const engineLabel = engine === "avatar_v" ? "Avatar V" : "Avatar IV";

  // Real-data summaries pulled from the live job state. Each falls back to
  // a generic line if its source field isn't populated yet.
  const stepSummary = (i: number): string => {
    const targetLabel = inputValue.trim() || "the prospect";
    switch (PIPELINE_STEPS[i].id) {
      case "scrape": {
        const lead = jobState?.lead;
        if (lead?.fullName) {
          const role = lead.role ? `${lead.role}` : "decision-maker";
          const company = lead.company?.name ?? targetLabel;
          return `Found ${lead.fullName}, ${role} — ${company}`;
        }
        return `Found the decision-maker at ${targetLabel}`;
      }
      case "stat": {
        const lead = jobState?.lead;
        const hero = lead?.website?.heroText;
        if (hero) return `Angle: ${hero}`;
        if (lead?.headline) return `Angle: ${lead.headline}`;
        return "Found the angle from their site and recent activity";
      }
      case "script": {
        const wc = jobState?.wordCount;
        const sec = jobState?.estimatedSeconds;
        if (wc && sec) return `Wrote ${wc}-word script, ~${sec}s spoken`;
        if (wc) return `Wrote ${wc}-word script`;
        return "Wrote the personalized script";
      }
      case "avatar": {
        const dur = jobState?.heygenDuration;
        const hs = jobState?.heygenStatus;
        if (dur) return `Rendered ${avatar.label} via ${engineLabel}, ${Math.round(dur)}s 1080p`;
        if (hs === "processing") return `Rendering ${avatar.label} via ${engineLabel}…`;
        if (hs === "waiting" || hs === "pending") return `Queued ${avatar.label} render on HeyGen`;
        return `Rendering ${avatar.label} via ${engineLabel}`;
      }
      case "compose": {
        if (jobState?.outputUrl) {
          return "Composed HyperFrames overlays — final video ready";
        }
        return "Composing HyperFrames overlays + transcript timing";
      }
      default:
        return "";
    }
  };

  return (
    <main className="relative min-h-screen w-full overflow-x-hidden">
      <div className="grain" aria-hidden="true" />
      {/* ===== Hero (compact) ===== */}
      <section className="relative">
        <div className="hero-glow" />
        <div className="relative z-10 mx-auto max-w-6xl px-6 pt-6 pb-4 text-center md:pt-10 md:pb-5">
          <div className="blur-in d-1 mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--border-token)] bg-white/70 px-3 py-1 text-xs backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--primary)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--primary)]" />
            </span>
            <span className="font-medium text-foreground">LeadFlow</span>
            <span className="text-muted">·</span>
            <span className="text-muted">HeyGen Hackathon · May 2026</span>
          </div>
          <h1 className="blur-in d-2 text-4xl font-semibold leading-[1.02] tracking-tight md:text-6xl">
            Personalized{" "}
            <span
              className="text-accent-gradient"
              style={{ fontStyle: "italic", fontWeight: 600 }}
            >
              Outbound
            </span>{" "}
            Video
          </h1>
          <p className="blur-in d-3 mx-auto mt-3 max-w-2xl text-sm text-muted md:text-base">
            Feels like your analyst wrote it and you delivered it. Without
            recording a thing.
          </p>
        </div>
      </section>

      {/* ===== Builder ===== */}
      <section id="builder" className="relative z-10 mx-auto max-w-5xl px-6 pb-8">
        <div className="glass rounded-3xl p-4 md:p-6">
          {/* Avatar + Voice chip row */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div ref={avatarRef} className="relative">
              <button
                onClick={() => setAvatarOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={avatarOpen}
                className="flex items-center gap-2 rounded-full border border-[var(--border-token-strong)] bg-[var(--surface)] px-3 py-2 text-sm transition hover:border-[var(--primary)]"
              >
                <AvatarThumb avatar={avatar} size={28} />
                <span className="flex flex-col items-start leading-tight">
                  <span className="font-medium">{avatar.label}</span>
                  <span className="text-[0.7rem] text-muted">
                    {avatarsLoading ? "Loading…" : "Avatar"}
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 text-muted" />
              </button>
              {avatarOpen && (
                <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-72 rounded-2xl border border-[var(--border-token-strong)] bg-white p-2 shadow-2xl">
                  {avatars.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setAvatar(a);
                        setAvatarOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition hover:bg-[var(--surface-strong)] ${
                        a.id === avatar.id ? "bg-[var(--surface)]" : ""
                      }`}
                    >
                      <AvatarThumb avatar={a} size={40} />
                      <span className="flex flex-1 flex-col">
                        <span className="font-medium">{a.label}</span>
                        <span className="text-[0.7rem] text-muted">{a.style}</span>
                      </span>
                      {a.id === avatar.id && (
                        <Check className="h-4 w-4 shrink-0 text-[var(--primary-light)]" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2 rounded-full border border-[var(--border-token-strong)] bg-[var(--surface)] p-1 text-xs">
              <Cpu className="ml-2 h-3.5 w-3.5 text-[var(--primary-light)]" />
              <span className="text-muted">Engine</span>
              <div className="inline-flex rounded-full bg-white p-0.5">
                <button
                  onClick={() => setEngine("avatar_iv")}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    engine === "avatar_iv"
                      ? "bg-[var(--primary)] text-white"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  Avatar IV
                </button>
                <button
                  onClick={() => setEngine("avatar_v")}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    engine === "avatar_v"
                      ? "bg-[var(--primary)] text-white"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  Avatar V
                </button>
              </div>
            </div>
          </div>

          {/* Voice / brand control */}
          <div className="mb-3 rounded-2xl border border-[var(--border-token)] bg-[var(--surface)] p-3">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
              <span className="h-1 w-1 rounded-full bg-[var(--primary)]" />
              Brand voice
            </div>
            <div className="mb-2 inline-flex rounded-full border border-[var(--border-token)] p-1 text-xs">
              <button
                onClick={() => setVoiceMode("templates")}
                className={`rounded-full px-3 py-1 transition ${
                  voiceMode === "templates"
                    ? "bg-[var(--primary)] text-white"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Templates
              </button>
              <button
                onClick={() => setVoiceMode("custom")}
                className={`rounded-full px-3 py-1 transition ${
                  voiceMode === "custom"
                    ? "bg-[var(--primary)] text-white"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Custom
              </button>
            </div>

            {voiceMode === "templates" ? (
              <div className="flex flex-wrap gap-2">
                {VOICE_TEMPLATES.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setVoiceTemplate(v.id)}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition ${
                      voiceTemplate === v.id
                        ? "border-[var(--primary)] bg-[var(--primary)]/15 text-foreground"
                        : "border-[var(--border-token)] text-muted hover:text-foreground"
                    }`}
                  >
                    <span className="font-medium">{v.label}</span>
                    <span className="text-[0.7rem] opacity-70">· {v.desc}</span>
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                value={voiceCustom}
                onChange={(e) => setVoiceCustom(e.target.value)}
                placeholder="Describe the voice and tone. e.g. 'Direct, no fluff. Never sound like a sales pitch.'"
                rows={2}
                className="w-full resize-none rounded-xl border border-[var(--border-token)] bg-white px-3 py-2 text-sm placeholder:text-muted/60 focus:border-[var(--primary)] focus:outline-none"
              />
            )}
          </div>

          {/* Target + Your company — side by side */}
          <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Target input */}
            <div className="rounded-2xl border border-[var(--border-token)] bg-[var(--surface)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
                <span className="h-1 w-1 rounded-full bg-[var(--primary)]" />
                Target
              </div>
              <div className="mb-2 inline-flex rounded-full border border-[var(--border-token)] p-1 text-xs">
                <button
                  onClick={() => setInputMode("linkedin")}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
                    inputMode === "linkedin"
                      ? "bg-[var(--primary)] text-white"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <Linkedin className="h-3.5 w-3.5" /> LinkedIn URL
                </button>
                <button
                  onClick={() => setInputMode("company")}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
                    inputMode === "company"
                      ? "bg-[var(--primary)] text-white"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <Building2 className="h-3.5 w-3.5" /> Company name
                </button>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-[var(--border-token)] bg-white px-3 py-2 focus-within:border-[var(--primary)]">
                {inputMode === "linkedin" ? (
                  <Linkedin className="h-4 w-4 shrink-0 text-[var(--primary-light)]" />
                ) : (
                  <Building2 className="h-4 w-4 shrink-0 text-[var(--primary-light)]" />
                )}
                <input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={
                    inputMode === "linkedin"
                      ? "linkedin.com/in/satyanadella"
                      : "Lumen Corp"
                  }
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted/60"
                />
              </div>
            </div>

            {/* Your company (sender) */}
            <div className="rounded-2xl border border-[var(--border-token)] bg-[var(--surface)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
                <span className="h-1 w-1 rounded-full bg-[var(--primary)]" />
                Your company
                <span className="ml-auto text-[0.7rem] normal-case text-muted/70">
                  Used in the avatar&apos;s intro
                </span>
              </div>
              {/* Spacer to align with Target's inner toggle row */}
              <div className="mb-2 h-[26px]" aria-hidden="true" />
              <div className="flex items-center gap-2 rounded-xl border border-[var(--border-token)] bg-white px-3 py-2 focus-within:border-[var(--primary)]">
                <Building2 className="h-4 w-4 shrink-0 text-[var(--primary-light)]" />
                <input
                  value={senderCompany}
                  onChange={(e) => setSenderCompany(e.target.value)}
                  placeholder="LeadFlow"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted/60"
                />
              </div>
            </div>
          </div>

          {/* Prompt */}
          <div className="mb-3 rounded-2xl border border-[var(--border-token)] bg-[var(--surface)] p-3">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
              <span className="h-1 w-1 rounded-full bg-[var(--primary)]" />
              What&apos;s the purpose of the video?
              <span className="ml-2 normal-case text-muted/70">
                Mention the offer, context, attach documents
              </span>
              <span
                className={`ml-auto font-mono text-[0.7rem] normal-case ${
                  prompt.length > PROMPT_LIMIT * 0.9
                    ? "text-[var(--primary-light)]"
                    : "text-muted/70"
                }`}
              >
                {prompt.length}/{PROMPT_LIMIT}
              </span>
            </div>
            <div className="rounded-xl border border-[var(--border-token)] bg-white p-2 focus-within:border-[var(--primary)]">
              <textarea
                value={prompt}
                onChange={(e) => {
                  if (e.target.value.length <= PROMPT_LIMIT) {
                    setPrompt(e.target.value);
                  }
                }}
                placeholder="Offer them a 30-day pilot to fix their homepage load time. Reference our case study and their recent hiring push."
                rows={2}
                className="w-full resize-none bg-transparent px-1 py-1 text-sm placeholder:text-muted/60 focus:outline-none"
              />

              {/* Attachment chips */}
              {attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {attachments.map((a) => {
                    const isImage = a.file.type.startsWith("image/");
                    return (
                      <div
                        key={a.id}
                        className="group flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border-token)] bg-[var(--surface)] py-1 pl-1 pr-1.5 text-[0.72rem]"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-strong)] text-[var(--primary)]">
                          {isImage && a.previewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={a.previewUrl}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : isImage ? (
                            <ImageIcon className="h-3.5 w-3.5" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="max-w-[160px] truncate font-medium text-foreground/90">
                            {a.file.name}
                          </span>
                          <span className="text-[0.65rem] text-muted">
                            {formatBytes(a.file.size)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(a.id)}
                          aria-label={`Remove ${a.file.name}`}
                          className="ml-1 flex h-5 w-5 items-center justify-center rounded-md text-muted transition hover:bg-[var(--surface-strong)] hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Toolbar */}
              <div className="mt-2 flex items-center gap-2 border-t border-[var(--border-token)] pt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                  onChange={(e) => handleFiles(e.target.files)}
                  className="sr-only"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attachments.length >= MAX_FILES}
                  title={
                    attachments.length >= MAX_FILES
                      ? `Max ${MAX_FILES} files`
                      : `Attach files · ${ALLOWED_HINT}`
                  }
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-[var(--surface-strong)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach
                </button>
                <span className="text-[0.7rem] text-muted/70">
                  {ALLOWED_HINT}
                </span>
                {attachments.length > 0 && (
                  <span className="ml-auto font-mono text-[0.7rem] text-muted">
                    {attachments.length}/{MAX_FILES} ·{" "}
                    {formatBytes(totalAttachedBytes)}/5 MB
                  </span>
                )}
              </div>

              {attachError && (
                <div className="mt-2 flex items-start gap-1.5 rounded-md bg-[var(--primary)]/8 px-2 py-1.5 text-[0.72rem] text-[var(--primary)]">
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{attachError}</span>
                </div>
              )}
            </div>
          </div>

          {/* CTA row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted/80">
              {disabledReason || (
                <span className="text-foreground/70">
                  Ready &nbsp;
                  <span className="font-mono text-muted/70">
                    <kbd className="rounded border border-[var(--border-token)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px]">⌘</kbd>
                    {" + "}
                    <kbd className="rounded border border-[var(--border-token)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px]">↵</kbd>
                  </span>
                </span>
              )}
            </div>
            <button
              onClick={startGeneration}
              disabled={!canGenerate}
              title={disabledReason || "Generate video"}
              className="group inline-flex items-center gap-2 rounded-full bg-foreground py-1.5 pl-5 pr-1.5 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span>{running ? "Generating…" : "Generate video"}</span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-white transition group-hover:bg-[var(--secondary)]">
                {running ? (
                  <Loader2 className="h-4 w-4 spin-ring" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* ===== Pipeline + Result ===== */}
      {(running || finishedAt || errorMsg || jobState) && (
        <section className="relative z-10 mx-auto max-w-5xl px-6 pb-10">
          <div className="glass rounded-3xl p-6 md:p-8">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-[var(--primary-light)]" />
                <span className="font-medium">Live generation</span>
                <span className="tag ml-2">
                  {finishedAt
                    ? "ready"
                    : `step ${completedCount + (running ? 1 : 0)} / ${PIPELINE_STEPS.length}`}
                </span>
              </div>
              <div className="text-xs text-muted">
                {finishedAt ? "Done" : "Working…"}
              </div>
            </div>

            <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-token)]">
              <div
                className="progress-bar h-full rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
              {PIPELINE_STEPS.map((step, i) => {
                const status = stepStatuses[i];
                const Icon = step.icon;
                return (
                  <div
                    key={step.id}
                    className={`flex flex-col gap-3 rounded-2xl border p-4 transition ${
                      status === "active"
                        ? "border-[var(--primary)] bg-[var(--primary)]/8"
                        : status === "done"
                          ? "border-[var(--border-token-strong)] bg-[var(--surface)]"
                          : "border-[var(--border-token)] bg-[var(--surface)] opacity-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-full ${
                          status === "active"
                            ? "bg-[var(--primary)] text-white"
                            : status === "done"
                              ? "bg-[var(--surface-strong)] text-[var(--primary-light)]"
                              : "bg-[var(--surface-strong)] text-muted"
                        }`}
                      >
                        {status === "active" ? (
                          <Loader2 className="h-4 w-4 spin-ring" />
                        ) : status === "done" ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Icon className="h-4 w-4" />
                        )}
                      </div>
                      <span className="font-mono text-[0.7rem] text-muted">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <div className="text-sm font-medium leading-tight">{step.label}</div>
                  </div>
                );
              })}
            </div>

            {/* Log feed — one line per completed step */}
            {(completedCount > 0 || running) && (
              <div className="surface-dark mt-5 rounded-2xl border border-black/40 p-4 font-mono text-[0.78rem] leading-relaxed">
                {PIPELINE_STEPS.map((step, i) => {
                  const status = stepStatuses[i];
                  if (status === "pending") return null;
                  if (status === "active") {
                    return (
                      <div key={step.id} className="flex items-center gap-2 text-white/55">
                        <Loader2 className="h-3 w-3 shrink-0 spin-ring text-[var(--primary-light)]" />
                        <span className="text-[var(--primary-light)]">
                          {step.label.toLowerCase()}…
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={step.id}
                      className="flex items-center gap-2 text-white/85"
                    >
                      <Check className="h-3 w-3 shrink-0 text-[var(--primary-light)]" />
                      <span>{stepSummary(i)}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Intermediate raw HeyGen preview — shown once HeyGen finishes
                but before HyperFrames composition completes, so the user can
                eyeball the avatar while the final render is still running. */}
            {jobState?.heygenVideoUrl && !outputUrl && (
              <div className="mt-6 rounded-2xl border border-[var(--border-token-strong)] bg-[var(--surface)] p-4 md:p-6">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs uppercase tracking-wide text-muted">
                    Avatar render (preview) · finalizing composition
                  </div>
                  <a
                    href={jobState.heygenVideoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--primary)] hover:underline"
                  >
                    Open in new tab ↗
                  </a>
                </div>
                <div
                  className="relative aspect-video overflow-hidden rounded-xl"
                  style={{
                    background:
                      "radial-gradient(ellipse at 30% 30%, rgba(248,113,113,0.30), transparent 60%), #0a0a0c",
                  }}
                >
                  <video
                    src={jobState.heygenVideoUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                  />
                </div>
              </div>
            )}

            {/* Result */}
            {finishedAt && outputUrl && (
              <div className="mt-6 grid grid-cols-1 gap-4 rounded-2xl border border-[var(--border-token-strong)] bg-[var(--surface)] p-4 md:grid-cols-[1.2fr_1fr] md:p-6">
                <div
                  className="relative aspect-video overflow-hidden rounded-xl"
                  style={{
                    background:
                      "radial-gradient(ellipse at 30% 30%, rgba(248,113,113,0.30), transparent 60%), #0a0a0c",
                  }}
                >
                  <video
                    src={outputUrl}
                    controls
                    autoPlay
                    playsInline
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute bottom-3 left-3 tag" style={{ background: "rgba(255,255,255,0.92)" }}>0:30 · 1080p</span>
                </div>
                <div className="flex flex-col gap-3">
                  <div className="text-xs uppercase tracking-wide text-muted">
                    Result
                  </div>
                  <div className="text-base font-medium">
                    {inputMode === "linkedin"
                      ? inputValue || "Your prospect"
                      : inputValue || "Your company"}
                  </div>
                  <div className="text-sm text-muted">
                    {prompt.slice(0, 140) || "Personalized 30-second outbound video."}
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <a
                      href={outputUrl}
                      download
                      className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
                    >
                      Download MP4
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(outputUrl).catch(() => {});
                      }}
                      className="rounded-full border border-[var(--border-token-strong)] px-4 py-1.5 text-xs transition hover:border-[var(--primary)]"
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={startGeneration}
                      className="rounded-full border border-[var(--border-token-strong)] px-4 py-1.5 text-xs transition hover:border-[var(--primary)]"
                    >
                      Regenerate
                    </button>
                  </div>
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="mt-6 flex items-start gap-2 rounded-2xl border border-[var(--primary)]/40 bg-[var(--primary)]/8 p-4 text-sm text-[var(--primary)]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">Generation failed</div>
                  <div className="mt-0.5 text-xs text-[var(--primary)]/80">{errorMsg}</div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ===== Email capture ===== */}
      <section id="email" className="relative z-10 mx-auto max-w-5xl px-6 pb-16 pt-4">
        <div className="glass glass-hover rounded-3xl p-6 md:p-8">
          <div className="flex flex-col items-start gap-5 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
                <Mail className="h-3.5 w-3.5 text-[var(--primary-light)]" />
                For B2B operators
              </div>
              <h3 className="text-2xl font-semibold tracking-tight md:text-3xl">
                Want the video sent directly to your inbox?
              </h3>
            </div>
            <form
              onSubmit={submitEmail}
              className="flex w-full max-w-md items-center gap-2 rounded-full border border-[var(--border-token-strong)] bg-[var(--surface)] p-1.5 md:w-auto"
            >
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full bg-transparent px-4 py-2 text-sm outline-none placeholder:text-muted/60 md:w-72"
              />
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-xs font-medium text-white transition hover:opacity-90"
              >
                {emailSent ? (
                  <>
                    <Check className="h-3.5 w-3.5" /> Got it
                  </>
                ) : (
                  <>
                    Get early access <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* ===== Gallery ===== */}
      <section id="gallery" className="relative z-10 mx-auto max-w-7xl px-6 pb-24">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
              <Video className="h-3.5 w-3.5 text-[var(--primary-light)]" />
              Gallery
            </div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Recent generations
            </h2>
            <p className="mt-1 text-sm text-muted">
              Pre-rendered samples. Click any to play.
            </p>
          </div>
          <Link
            href="/gallery"
            className="hidden items-center gap-1.5 rounded-full border border-[var(--border-token-strong)] px-4 py-2 text-xs transition hover:border-[var(--primary)] md:inline-flex"
          >
            View all
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {galleryEntries.slice(0, 4).map((g) => (
            <div
              key={g.id}
              className="glass glass-hover group flex flex-col overflow-hidden rounded-2xl text-left"
            >
              <div
                className="relative flex aspect-video items-center justify-center overflow-hidden"
                style={{
                  background: `radial-gradient(ellipse at 30% 30%, ${g.accent}55, transparent 65%), #0a0a0c`,
                }}
              >
                {g.videoUrl ? (
                  <video
                    src={g.videoUrl}
                    controls
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <>
                    <span
                      className="flex h-12 w-12 items-center justify-center rounded-full text-sm font-semibold text-white shadow-lg"
                      style={{ background: g.accent }}
                    >
                      {g.name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")}
                    </span>
                    <span
                      className="absolute bottom-3 left-3 tag"
                      style={{ background: "rgba(255,255,255,0.92)" }}
                    >
                      0:30
                    </span>
                    <span className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0a0a0c] opacity-0 shadow-lg transition group-hover:opacity-100">
                      <Play className="h-4 w-4 translate-x-[1px]" fill="currentColor" />
                    </span>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-1 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{g.name}</div>
                  <ChevronDown className="h-3.5 w-3.5 -rotate-90 text-muted transition group-hover:text-foreground" />
                </div>
                <div className="text-xs text-muted">
                  {g.role} · {g.company}
                </div>
                <div className="mt-2 text-xs font-medium text-[var(--primary)]">{g.stat}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ===== What's next ===== */}
      <section id="whats-next" className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-4">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
              <Wand2 className="h-3.5 w-3.5 text-[var(--primary-light)]" />
              On the roadmap
            </div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Ditch the{" "}
              <span
                className="text-accent-gradient"
                style={{ fontStyle: "italic", fontWeight: 600 }}
              >
                Loom
              </span>
              . Upload the deck.
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted md:text-base">
              Drop in your docs or a presentation. LeadFlow returns a
              motion-graphics walkthrough narrated by your AI avatar.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--primary)]/30 bg-[var(--primary)]/8 px-3 py-1.5 text-xs font-medium text-[var(--primary)]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--primary)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
            </span>
            Launching soon
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="border-t border-[var(--border-token)] py-8 text-center text-xs text-muted">
        <div className="mx-auto max-w-7xl px-6">
          LeadFlow · Built for the HeyGen hackathon · May 2026
        </div>
      </footer>
    </main>
  );
}
