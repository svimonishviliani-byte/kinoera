import React, { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from "react";
import {
  Play, Info, Search, Menu, X, ChevronLeft, ChevronRight, Star, Plus, Check,
  Pause, Volume2, VolumeX, Maximize, Minimize, Settings, SkipForward, Clock,
  User, LogIn, UserPlus, LayoutDashboard, Trash2, Pencil, Save, ArrowLeft,
  Film, Tv, Grid3x3, ListVideo, History, Home as HomeIcon, Subtitles
} from "lucide-react";
import { storageGet, storageSet } from "./lib/storage.js";
import { supabase, isSupabaseConfigured } from "./lib/supabaseClient.js";
import { GENRES, IMG, DEMO_VIDEO, rawMovies, rawSeries, makeEpisodes, rowToItem, itemToRow } from "./data/catalog.js";

/* =========================================================================
   THEME TOKENS
========================================================================= */
const THEME = {
  bg: "#0A0D14",
  bgAlt: "#0E121C",
  surface: "#141A26",
  surface2: "#1B2233",
  border: "#232B3D",
  text: "#F2F0EA",
  textMuted: "#8B93A7",
  accent: "#E8A33D",
  accentDim: "#C4842A",
  accent2: "#3E8E8A",
  danger: "#C1554A",
};

/* =========================================================================
   APP DATA CONTEXT (catalog + auth + my list + history)
   Catalog + authentication run through Supabase when configured (see
   src/lib/supabaseClient.js). My list / watch history stay in this
   browser's localStorage (see src/lib/storage.js) since they are
   per-device conveniences, not account data.
========================================================================= */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

function AppProvider({ children }) {
  const [movies, setMovies] = useState(rawMovies);
  const [series, setSeries] = useState(rawSeries);
  const [myList, setMyList] = useState([]); // array of {id, type}
  const [history, setHistory] = useState([]); // array of {id, type, at, seasonEp}
  const [user, setUser] = useState(null); // { id, email, name, role }
  const [localLoaded, setLocalLoaded] = useState(false);
  const [authLoaded, setAuthLoaded] = useState(!isSupabaseConfigured);

  /* ---- per-device data: My List + watch history (always local) ---- */
  useEffect(() => {
    (async () => {
      const [savedList, savedHistory] = await Promise.all([
        storageGet("mylist", []),
        storageGet("history", []),
      ]);
      setMyList(savedList || []);
      setHistory(savedHistory || []);
      setLocalLoaded(true);
    })();
  }, []);

  /* ---- catalog: Supabase table when configured, bundled demo data otherwise ---- */
  const refetchCatalog = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    const { data, error } = await supabase.from("movies").select("*").order("created_at", { ascending: true });
    if (error) { console.error("Konoera: could not load catalog", error.message); return; }
    const items = (data || []).map(rowToItem);
    setMovies(items.filter((x) => x.type === "movie"));
    setSeries(items.filter((x) => x.type === "series"));
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    refetchCatalog();
    const channel = supabase
      .channel("movies-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "movies" }, () => refetchCatalog())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refetchCatalog]);

  /* ---- auth: Supabase session + role from the profiles table ---- */
  const loadProfile = useCallback(async (authUser) => {
    if (!authUser) { setUser(null); return; }
    const { data } = await supabase.from("profiles").select("*").eq("id", authUser.id).single();
    setUser({
      id: authUser.id,
      email: authUser.email,
      name: data?.display_name || authUser.email.split("@")[0],
      role: data?.role || "user",
    });
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) { setAuthLoaded(true); return; }
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      await loadProfile(data.session?.user || null);
      if (active) setAuthLoaded(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      loadProfile(session?.user || null);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  const catalog = useMemo(() => [...movies, ...series], [movies, series]);
  const findById = useCallback((id) => catalog.find((x) => x.id === id), [catalog]);

  const toggleMyList = useCallback(async (id, type) => {
    setMyList((prev) => {
      const exists = prev.some((x) => x.id === id);
      const next = exists ? prev.filter((x) => x.id !== id) : [...prev, { id, type }];
      storageSet("mylist", next);
      return next;
    });
  }, []);

  const isInMyList = useCallback((id) => myList.some((x) => x.id === id), [myList]);

  const pushHistory = useCallback((entry) => {
    setHistory((prev) => {
      const filtered = prev.filter((x) => !(x.id === entry.id && x.seasonEp === entry.seasonEp));
      const next = [{ ...entry, at: Date.now() }, ...filtered].slice(0, 50);
      storageSet("history", next);
      return next;
    });
  }, []);

  /* ---- account actions ---- */
  const register = useCallback(async (name, email, password) => {
    if (!isSupabaseConfigured) return { error: "ავტორიზაცია ჯერ არ არის კონფიგურირებული — იხილეთ README.md." };
    const { data, error } = await supabase.auth.signUp({
      email, password, options: { data: { display_name: name } },
    });
    if (error) return { error: error.message };
    return { needsConfirmation: !data.session };
  }, []);

  const login = useCallback(async (email, password) => {
    if (!isSupabaseConfigured) return { error: "ავტორიზაცია ჯერ არ არის კონფიგურირებული — იხილეთ README.md." };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message };
  }, []);

  const logout = useCallback(async () => {
    if (!isSupabaseConfigured) { setUser(null); return; }
    await supabase.auth.signOut();
  }, []);

  /* ---- admin catalog writes — everyone sees them instantly via realtime ---- */
  const saveMovieItem = useCallback(async (item) => {
    if (!isSupabaseConfigured) return { error: "Supabase არ არის კონფიგურირებული." };
    const { error } = await supabase.from("movies").upsert(itemToRow(item));
    if (error) return { error: error.message };
    await refetchCatalog();
    return {};
  }, [refetchCatalog]);

  const deleteMovieItem = useCallback(async (id) => {
    if (!isSupabaseConfigured) return { error: "Supabase არ არის კონფიგურირებული." };
    const { error } = await supabase.from("movies").delete().eq("id", id);
    if (error) return { error: error.message };
    await refetchCatalog();
    return {};
  }, [refetchCatalog]);

  const uploadPoster = useCallback(async (file, idHint) => {
    if (!isSupabaseConfigured) return { error: "Supabase არ არის კონფიგურირებული." };
    const safeName = file.name.replace(/[^a-zA-Z0-9.]/g, "-");
    const path = `${idHint || "poster"}-${Date.now()}-${safeName}`;
    const { error } = await supabase.storage.from("posters").upload(path, file, { upsert: true });
    if (error) return { error: error.message };
    const { data } = supabase.storage.from("posters").getPublicUrl(path);
    return { url: data.publicUrl };
  }, []);

  const value = {
    movies, series, catalog, findById,
    loaded: localLoaded && authLoaded,
    myList, toggleMyList, isInMyList,
    history, pushHistory,
    user, isAdmin: user?.role === "admin",
    login, register, logout,
    saveMovieItem, deleteMovieItem, uploadPoster,
    supabaseReady: isSupabaseConfigured,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/* =========================================================================
   SMALL UI PRIMITIVES
========================================================================= */
function Rating({ value }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm" style={{ color: THEME.accent }}>
      <Star size={14} fill={THEME.accent} strokeWidth={0} />
      {value.toFixed(1)}
    </span>
  );
}

function Badge({ children }) {
  return (
    <span
      className="text-xs px-2 py-1 rounded-md"
      style={{ background: THEME.surface2, color: THEME.textMuted, border: `1px solid ${THEME.border}` }}
    >
      {children}
    </span>
  );
}

function Button({ children, onClick, variant = "primary", className = "", type = "button", disabled }) {
  const styles = {
    primary: { background: THEME.accent, color: "#181206" },
    ghost: { background: THEME.surface2, color: THEME.text, border: `1px solid ${THEME.border}` },
    outline: { background: "transparent", color: THEME.text, border: `1px solid ${THEME.border}` },
    danger: { background: "rgba(193,85,74,0.15)", color: "#E58C82", border: `1px solid rgba(193,85,74,0.4)` },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-150 hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      style={styles[variant]}
    >
      {children}
    </button>
  );
}

function LoadingState({ label = "იტვირთება..." }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3">
      <div
        className="w-8 h-8 rounded-full border-2 animate-spin"
        style={{ borderColor: THEME.border, borderTopColor: THEME.accent }}
      />
      <p style={{ color: THEME.textMuted }} className="text-sm">{label}</p>
    </div>
  );
}

function EmptyState({ icon: Icon = Search, title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center gap-3">
      <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: THEME.surface2 }}>
        <Icon size={24} style={{ color: THEME.textMuted }} />
      </div>
      <h3 className="text-lg font-medium" style={{ color: THEME.text }}>{title}</h3>
      {subtitle && <p className="text-sm max-w-sm" style={{ color: THEME.textMuted }}>{subtitle}</p>}
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center gap-3">
      <p style={{ color: THEME.danger }} className="text-sm">{message}</p>
      {onRetry && <Button variant="outline" onClick={onRetry}>ხელახლა ცდა</Button>}
    </div>
  );
}

/* =========================================================================
   CARD + ROW
========================================================================= */
function TitleCard({ item, onOpen }) {
  const { isInMyList, toggleMyList } = useApp();
  const saved = isInMyList(item.id);
  return (
    <div className="group relative shrink-0 w-[150px] sm:w-[170px] md:w-[190px] cursor-pointer" onClick={() => onOpen(item)}>
      <div
        className="relative rounded-xl overflow-hidden aspect-[2/3] transition-transform duration-200 group-hover:-translate-y-1"
        style={{ background: THEME.surface, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}
      >
        <img src={item.poster} alt={item.title} className="w-full h-full object-cover" loading="lazy" />
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-end p-3"
          style={{ background: "linear-gradient(180deg, rgba(10,13,20,0) 40%, rgba(10,13,20,0.92) 100%)" }}>
          <div className="flex items-center gap-2">
            <button
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: THEME.accent, color: "#181206" }}
              onClick={(e) => { e.stopPropagation(); onOpen(item); }}
              aria-label="ყურება"
            >
              <Play size={14} fill="#181206" />
            </button>
            <button
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: "rgba(255,255,255,0.12)", color: THEME.text }}
              onClick={(e) => { e.stopPropagation(); toggleMyList(item.id, item.type); }}
              aria-label="ჩემს სიაში დამატება"
            >
              {saved ? <Check size={14} /> : <Plus size={14} />}
            </button>
          </div>
        </div>
        <div className="absolute top-2 left-2">
          <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "rgba(10,13,20,0.7)", color: THEME.accent }}>
            {item.type === "series" ? "სერიალი" : "ფილმი"}
          </span>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="text-sm font-medium leading-snug line-clamp-1" style={{ color: THEME.text }}>{item.title}</h4>
        <div className="flex items-center gap-2 mt-1 text-xs" style={{ color: THEME.textMuted }}>
          <span>{item.year}</span>
          <span>·</span>
          <Rating value={item.rating} />
        </div>
      </div>
    </div>
  );
}

function Row({ title, items, onOpen }) {
  const scrollerRef = useRef(null);
  const scrollBy = (dir) => {
    if (scrollerRef.current) scrollerRef.current.scrollBy({ left: dir * 640, behavior: "smooth" });
  };
  if (!items || items.length === 0) return null;
  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-3 px-4 md:px-8">
        <h3 className="text-lg md:text-xl font-semibold" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>{title}</h3>
        <div className="hidden sm:flex items-center gap-2">
          <button onClick={() => scrollBy(-1)} className="w-8 h-8 rounded-full flex items-center justify-center hover:brightness-125" style={{ background: THEME.surface2, color: THEME.textMuted }}><ChevronLeft size={16} /></button>
          <button onClick={() => scrollBy(1)} className="w-8 h-8 rounded-full flex items-center justify-center hover:brightness-125" style={{ background: THEME.surface2, color: THEME.textMuted }}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div ref={scrollerRef} className="flex gap-3 md:gap-4 overflow-x-auto px-4 md:px-8 pb-2 scroll-smooth" style={{ scrollbarWidth: "none" }}>
        {items.map((it) => <TitleCard key={it.id} item={it} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

/* =========================================================================
   NAVBAR
========================================================================= */
function NavLink({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-sm px-1 py-2 transition-colors relative"
      style={{ color: active ? THEME.text : THEME.textMuted }}
    >
      {label}
      {active && <span className="absolute left-0 right-0 -bottom-[1px] h-[2px] rounded-full" style={{ background: THEME.accent }} />}
    </button>
  );
}

function Navbar({ route, go, query, setQuery, onSearchSubmit }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { user, isAdmin } = useApp();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { key: "home", label: "მთავარი" },
    { key: "movies", label: "ფილმები" },
    { key: "series", label: "სერიალები" },
    { key: "genres", label: "ჟანრები" },
    { key: "mylist", label: "ჩემი სია" },
  ];

  return (
    <header
      className="sticky top-0 z-40 transition-colors duration-200"
      style={{
        background: scrolled ? "rgba(10,13,20,0.92)" : "linear-gradient(180deg, rgba(10,13,20,0.85) 0%, rgba(10,13,20,0) 100%)",
        backdropFilter: scrolled ? "blur(10px)" : "none",
        borderBottom: scrolled ? `1px solid ${THEME.border}` : "1px solid transparent",
      }}
    >
      <div className="max-w-[1400px] mx-auto px-4 md:px-8 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <button onClick={() => go("home")} className="flex items-center gap-1 shrink-0">
            <span style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.accent }} className="text-xl font-bold tracking-tight">Konoera</span>
            <span style={{ color: THEME.textMuted }} className="text-xl font-light">.ge</span>
          </button>
          <nav className="hidden lg:flex items-center gap-6">
            {links.map((l) => (
              <NavLink key={l.key} label={l.label} active={route.name === l.key} onClick={() => go(l.key)} />
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <form
            onSubmit={(e) => { e.preventDefault(); onSearchSubmit(); }}
            className="hidden md:flex items-center rounded-lg px-3 py-2 gap-2 w-56 lg:w-72"
            style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}
          >
            <Search size={15} style={{ color: THEME.textMuted }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ძებნა..."
              className="bg-transparent outline-none text-sm w-full"
              style={{ color: THEME.text }}
            />
          </form>
          <button className="md:hidden w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: THEME.surface }} onClick={() => go("search")}>
            <Search size={16} style={{ color: THEME.text }} />
          </button>
          {isAdmin && (
            <button
              onClick={() => go("admin")}
              className="hidden sm:flex w-9 h-9 rounded-lg items-center justify-center shrink-0"
              style={{ background: route.name === "admin" ? THEME.accent : THEME.surface, color: route.name === "admin" ? "#181206" : THEME.textMuted }}
              aria-label="ადმინ პანელი"
              title="ადმინ პანელი"
            >
              <LayoutDashboard size={15} />
            </button>
          )}
          <button
            onClick={() => go(user ? "profile" : "login")}
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: THEME.surface2, border: `1px solid ${THEME.border}` }}
            aria-label="პროფილი"
          >
            {user ? (
              <span className="text-xs font-semibold" style={{ color: THEME.accent }}>{user.name?.[0]?.toUpperCase() || "მ"}</span>
            ) : (
              <User size={15} style={{ color: THEME.textMuted }} />
            )}
          </button>
          <button className="lg:hidden w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: THEME.surface }} onClick={() => setMobileOpen((v) => !v)}>
            {mobileOpen ? <X size={17} style={{ color: THEME.text }} /> : <Menu size={17} style={{ color: THEME.text }} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="lg:hidden px-4 pb-4 flex flex-col gap-1" style={{ background: THEME.bg, borderBottom: `1px solid ${THEME.border}` }}>
          {links.map((l) => (
            <button
              key={l.key}
              onClick={() => { go(l.key); setMobileOpen(false); }}
              className="text-left px-3 py-3 rounded-lg text-sm"
              style={{ color: route.name === l.key ? THEME.text : THEME.textMuted, background: route.name === l.key ? THEME.surface2 : "transparent" }}
            >
              {l.label}
            </button>
          ))}
          {isAdmin && (
            <button onClick={() => { go("admin"); setMobileOpen(false); }} className="text-left px-3 py-3 rounded-lg text-sm flex items-center gap-2" style={{ color: route.name === "admin" ? THEME.text : THEME.textMuted, background: route.name === "admin" ? THEME.surface2 : "transparent" }}>
              <LayoutDashboard size={15} /> ადმინ პანელი
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function Footer({ go }) {
  const { isAdmin } = useApp();
  return (
    <footer className="mt-16 py-10 px-4 md:px-8" style={{ borderTop: `1px solid ${THEME.border}`, background: THEME.bgAlt }}>
      <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div>
          <div className="flex items-center gap-1 mb-2">
            <span style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.accent }} className="text-lg font-bold">Konoera</span>
            <span style={{ color: THEME.textMuted }} className="text-lg font-light">.ge</span>
          </div>
          <p className="text-xs max-w-xs" style={{ color: THEME.textMuted }}>ქართული ფილმებისა და სერიალების სტრიმინგ-პლატფორმა. დემო-პროექტი, ყველა შინაარსი გამოგონილია.</p>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <button onClick={() => go("movies")} style={{ color: THEME.textMuted }}>ფილმები</button>
          <button onClick={() => go("series")} style={{ color: THEME.textMuted }}>სერიალები</button>
          <button onClick={() => go("genres")} style={{ color: THEME.textMuted }}>ჟანრები</button>
          <button onClick={() => go("mylist")} style={{ color: THEME.textMuted }}>ჩემი სია</button>
          {isAdmin && <button onClick={() => go("admin")} style={{ color: THEME.textMuted }}>ადმინ პანელი</button>}
        </div>
      </div>
      <p className="text-xs mt-8" style={{ color: THEME.textMuted }}>© 2026 Konoera.ge — ყველა უფლება დაცულია.</p>
    </footer>
  );
}

/* =========================================================================
   HERO
========================================================================= */
function Hero({ item, go }) {
  if (!item) return null;
  return (
    <section className="relative w-full" style={{ height: "min(78vh, 640px)" }}>
      <img src={item.backdrop} alt={item.title} className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(10,13,20,0.95) 15%, rgba(10,13,20,0.55) 55%, rgba(10,13,20,0.15) 100%)" }} />
      <div className="absolute inset-0" style={{ background: "linear-gradient(0deg, rgba(10,13,20,1) 0%, rgba(10,13,20,0) 35%)" }} />
      <div className="relative h-full max-w-[1400px] mx-auto px-4 md:px-8 flex flex-col justify-end pb-12 md:pb-16">
        <div className="max-w-xl">
          <div className="flex items-center gap-2 mb-3">
            <Badge>{item.type === "series" ? "სერიალი" : "ფილმი"}</Badge>
            <Badge>{item.year}</Badge>
            <Rating value={item.rating} />
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold mb-3 leading-tight" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>
            {item.title}
          </h1>
          <p className="text-sm md:text-base mb-6 line-clamp-3" style={{ color: THEME.textMuted }}>{item.description}</p>
          <div className="flex items-center gap-3">
            <Button onClick={() => go(item.type === "series" ? "watch" : "watch", item.id)}>
              <Play size={16} fill="#181206" /> ყურება
            </Button>
            <Button variant="ghost" onClick={() => go(item.type === "series" ? "series-detail" : "movie-detail", item.id)}>
              <Info size={16} /> დეტალურად
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   VIDEO PLAYER
========================================================================= */
function VideoPlayer({ item, seasonNumber, episode, onEnded, onNextEpisode, go }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const menuRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showSubs, setShowSubs] = useState(false);
  const [quality, setQuality] = useState("Auto");
  const [subtitle, setSubtitle] = useState("გამორთული");
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef(null);

  const src = episode?.videoUrl || item.videoUrl || DEMO_VIDEO;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted || volume === 0;
  }, [volume, muted]);

  // keep the fullscreen icon correct even when exited via Esc / browser chrome
  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // close the quality/subtitle dropdowns when clicking outside of them
  useEffect(() => {
    if (!showQuality && !showSubs) return;
    const onClickAway = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowQuality(false);
        setShowSubs(false);
      }
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showQuality, showSubs]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    setProgress(v.currentTime / v.duration);
  };

  const onLoadedMeta = () => {
    const v = videoRef.current;
    if (v) setDuration(v.duration || 0);
  };

  const seek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const v = videoRef.current;
    if (v && v.duration) v.currentTime = pct * v.duration;
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  const fmt = (t) => {
    if (!isFinite(t)) return "0:00";
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // controls stay visible while paused / when a menu is open; auto-hide only during playback
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    if (playing && !showQuality && !showSubs) {
      hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, [playing, showQuality, showSubs]);

  useEffect(() => {
    showControls();
    return () => clearTimeout(hideTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // first tap on mobile reveals controls instead of immediately toggling play
  const handleVideoTap = () => {
    if (!controlsVisible) { showControls(); return; }
    togglePlay();
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full bg-black rounded-xl overflow-hidden group"
      style={{ aspectRatio: "16/9" }}
      onMouseMove={showControls}
      onTouchStart={showControls}
    >
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-contain bg-black"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onClick={handleVideoTap}
        onEnded={() => { setPlaying(false); onEnded && onEnded(); }}
        playsInline
      />
      {subtitle !== "გამორთული" && (
        <div className="absolute bottom-16 left-0 right-0 flex justify-center pointer-events-none">
          <span className="px-3 py-1 rounded text-sm" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}>
            [{subtitle} სუბტიტრები აქტიურია — დემო რეჟიმი]
          </span>
        </div>
      )}

      {!playing && (
        <button onClick={togglePlay} aria-label="დაკვრა" className="absolute inset-0 flex items-center justify-center">
          <span className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "rgba(232,163,61,0.9)" }}>
            <Play size={26} fill="#181206" color="#181206" />
          </span>
        </button>
      )}

      <div
        className="absolute bottom-0 left-0 right-0 px-4 pb-3 pt-8 transition-opacity duration-200"
        style={{ background: "linear-gradient(0deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%)", opacity: controlsVisible ? 1 : 0 }}
      >
        <div className="h-1.5 w-full rounded-full cursor-pointer mb-3" style={{ background: "rgba(255,255,255,0.25)" }} onClick={seek}>
          <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: THEME.accent }} />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={togglePlay} aria-label={playing ? "პაუზა" : "დაკვრა"}>{playing ? <Pause size={18} color="#fff" /> : <Play size={18} color="#fff" fill="#fff" />}</button>
            {episode && onNextEpisode && (
              <button onClick={onNextEpisode} aria-label="შემდეგი ეპიზოდი" title="შემდეგი ეპიზოდი"><SkipForward size={18} color="#fff" /></button>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => setMuted((m) => !m)} aria-label={muted ? "ხმის ჩართვა" : "დადუმება"}>
                {muted || volume === 0 ? <VolumeX size={18} color="#fff" /> : <Volume2 size={18} color="#fff" />}
              </button>
              <input
                type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
                onChange={(e) => { setVolume(parseFloat(e.target.value)); setMuted(false); }}
                className="w-16 accent-current"
                style={{ accentColor: THEME.accent }}
                aria-label="ხმის დონე"
              />
            </div>
            <span className="text-xs hidden sm:inline" style={{ color: "#ccc" }}>
              {fmt(progress * duration)} / {fmt(duration)}
            </span>
          </div>
          <div ref={menuRef} className="flex items-center gap-3 relative">
            <div className="relative">
              <button onClick={() => { setShowSubs((v) => !v); setShowQuality(false); }} aria-label="სუბტიტრები" title="სუბტიტრები"><Subtitles size={18} color="#fff" /></button>
              {showSubs && (
                <div className="absolute bottom-8 right-0 rounded-lg py-1 min-w-[140px] z-10" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
                  {["გამორთული", "ქართული", "English"].map((s) => (
                    <button key={s} onClick={() => { setSubtitle(s); setShowSubs(false); }} className="block w-full text-left px-3 py-2 text-xs hover:brightness-125" style={{ color: subtitle === s ? THEME.accent : THEME.text }}>{s}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative">
              <button onClick={() => { setShowQuality((v) => !v); setShowSubs(false); }} aria-label="ხარისხი" title="ხარისხი"><Settings size={18} color="#fff" /></button>
              {showQuality && (
                <div className="absolute bottom-8 right-0 rounded-lg py-1 min-w-[110px] z-10" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
                  {["Auto", "1080p", "720p", "480p"].map((q) => (
                    <button key={q} onClick={() => { setQuality(q); setShowQuality(false); }} className="block w-full text-left px-3 py-2 text-xs hover:brightness-125" style={{ color: quality === q ? THEME.accent : THEME.text }}>{q}</button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={toggleFullscreen} aria-label={fullscreen ? "სრული ეკრანიდან გამოსვლა" : "სრულ ეკრანზე"} title="სრულ ეკრანზე">
              {fullscreen ? <Minimize size={18} color="#fff" /> : <Maximize size={18} color="#fff" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   PAGES
========================================================================= */
function HomePage({ go }) {
  const { movies, series, loaded } = useApp();
  if (!loaded) return <LoadingState />;
  const hero = movies.find((m) => m.id === "m1") || movies[0];
  const popularMovies = movies.filter((m) => m.popular);
  const popularSeries = series.filter((s) => s.popular);
  const newlyAdded = [...movies, ...series].filter((x) => x.newlyAdded);
  const trending = [...movies, ...series].filter((x) => x.trending);
  const recommended = [...movies, ...series].filter((x) => x.recommended);

  const open = (item) => go(item.type === "series" ? "series-detail" : "movie-detail", item.id);

  return (
    <div>
      <Hero item={hero} go={go} />
      <div className="pt-8">
        <Row title="პოპულარული ფილმები" items={popularMovies} onOpen={open} />
        <Row title="პოპულარული სერიალები" items={popularSeries} onOpen={open} />
        <Row title="ახლად დამატებული" items={newlyAdded} onOpen={open} />
        <Row title="ტრენდული" items={trending} onOpen={open} />
        <Row title="შენთვის რეკომენდებული" items={recommended} onOpen={open} />
      </div>
    </div>
  );
}

function FilterBar({ filters, setFilters, years }) {
  const sel = "text-sm px-3 py-2 rounded-lg outline-none";
  return (
    <div className="flex flex-wrap gap-3 px-4 md:px-8 py-4">
      <select className={sel} style={{ background: THEME.surface, color: THEME.text, border: `1px solid ${THEME.border}` }}
        value={filters.genre} onChange={(e) => setFilters((f) => ({ ...f, genre: e.target.value }))}>
        <option value="">ყველა ჟანრი</option>
        {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
      </select>
      <select className={sel} style={{ background: THEME.surface, color: THEME.text, border: `1px solid ${THEME.border}` }}
        value={filters.year} onChange={(e) => setFilters((f) => ({ ...f, year: e.target.value }))}>
        <option value="">ყველა წელი</option>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      <select className={sel} style={{ background: THEME.surface, color: THEME.text, border: `1px solid ${THEME.border}` }}
        value={filters.minRating} onChange={(e) => setFilters((f) => ({ ...f, minRating: e.target.value }))}>
        <option value="">ნებისმიერი რეიტინგი</option>
        <option value="9">9.0+</option>
        <option value="8">8.0+</option>
        <option value="7">7.0+</option>
        <option value="6">6.0+</option>
      </select>
      <select className={sel} style={{ background: THEME.surface, color: THEME.text, border: `1px solid ${THEME.border}` }}
        value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
        <option value="popular">დალაგება: პოპულარობით</option>
        <option value="new">დალაგება: სიახლით</option>
        <option value="rating">დალაგება: რეიტინგით</option>
      </select>
    </div>
  );
}

function applyFilters(list, filters) {
  let out = [...list];
  if (filters.genre) out = out.filter((x) => x.genres.includes(filters.genre));
  if (filters.year) out = out.filter((x) => String(x.year) === String(filters.year));
  if (filters.minRating) out = out.filter((x) => x.rating >= parseFloat(filters.minRating));
  if (filters.sort === "new") out.sort((a, b) => b.year - a.year);
  else if (filters.sort === "rating") out.sort((a, b) => b.rating - a.rating);
  else out.sort((a, b) => (b.popular === a.popular ? b.rating - a.rating : b.popular ? 1 : -1));
  return out;
}

function GridPage({ title, items, go, type }) {
  const { loaded } = useApp();
  const [filters, setFilters] = useState({ genre: "", year: "", minRating: "", sort: "popular" });
  const years = useMemo(() => [...new Set(items.map((i) => i.year))].sort((a, b) => b - a), [items]);
  const filtered = useMemo(() => applyFilters(items, filters), [items, filters]);
  const open = (item) => go(item.type === "series" ? "series-detail" : "movie-detail", item.id);

  if (!loaded) return <LoadingState />;

  return (
    <div className="pt-8 max-w-[1400px] mx-auto">
      <h1 className="text-2xl md:text-3xl font-bold px-4 md:px-8" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>{title}</h1>
      <FilterBar filters={filters} setFilters={setFilters} years={years} />
      {filtered.length === 0 ? (
        <EmptyState icon={type === "series" ? Tv : Film} title="შედეგი ვერ მოიძებნა" subtitle="სცადეთ ფილტრის შეცვლა ან პარამეტრების გასუფთავება." />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 md:gap-5 px-4 md:px-8 pb-10">
          {filtered.map((it) => (
            <div key={it.id} className="w-full">
              <TitleCard item={it} onOpen={open} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GenresPage({ go }) {
  const { catalog } = useApp();
  const counts = useMemo(() => {
    const m = {};
    GENRES.forEach((g) => { m[g] = catalog.filter((x) => x.genres.includes(g)).length; });
    return m;
  }, [catalog]);
  return (
    <div className="pt-10 max-w-[1400px] mx-auto px-4 md:px-8 pb-10">
      <h1 className="text-2xl md:text-3xl font-bold mb-6" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>ჟანრები</h1>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {GENRES.map((g, i) => (
          <button
            key={g}
            onClick={() => go("genre-detail", g)}
            className="relative rounded-xl p-6 text-left overflow-hidden hover:-translate-y-1 transition-transform duration-200"
            style={{ background: `linear-gradient(135deg, ${THEME.surface2}, ${THEME.surface})`, border: `1px solid ${THEME.border}` }}
          >
            <Grid3x3 size={18} style={{ color: THEME.accent }} className="mb-6" />
            <h3 className="text-lg font-semibold" style={{ color: THEME.text }}>{g}</h3>
            <p className="text-xs mt-1" style={{ color: THEME.textMuted }}>{counts[g]} სათაური</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function GenreDetailPage({ genre, go }) {
  const { catalog } = useApp();
  const items = catalog.filter((x) => x.genres.includes(genre));
  return <GridPage title={`ჟანრი: ${genre}`} items={items} go={go} />;
}

function SearchPage({ go, query, setQuery }) {
  const { catalog } = useApp();
  const q = query;
  const results = useMemo(() => {
    if (!q.trim()) return [];
    const lower = q.trim().toLowerCase();
    return catalog.filter((x) => x.title.toLowerCase().includes(lower) || x.genres.some((g) => g.includes(q.trim())));
  }, [q, catalog]);
  const open = (item) => go(item.type === "series" ? "series-detail" : "movie-detail", item.id);

  return (
    <div className="pt-10 max-w-[1400px] mx-auto px-4 md:px-8 pb-10">
      <h1 className="text-2xl md:text-3xl font-bold mb-6" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>ძებნა</h1>
      <div className="flex items-center gap-2 rounded-lg px-4 py-3 mb-8 max-w-xl" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
        <Search size={16} style={{ color: THEME.textMuted }} />
        <input autoFocus value={q} onChange={(e) => setQuery(e.target.value)} placeholder="მოძებნეთ ფილმი ან სერიალი..." className="bg-transparent outline-none text-sm w-full" style={{ color: THEME.text }} />
      </div>
      {q.trim() === "" ? (
        <EmptyState icon={Search} title="დაიწყეთ ძებნა" subtitle="სცადეთ სათაურის ან ჟანრის ჩაწერა." />
      ) : results.length === 0 ? (
        <EmptyState icon={Search} title={`ვერაფერი მოიძებნა „${q}“-სთვის`} subtitle="შეამოწმეთ მართლწერა ან სცადეთ სხვა საკვანძო სიტყვა." />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 md:gap-5">
          {results.map((it) => <TitleCard key={it.id} item={it} onOpen={open} />)}
        </div>
      )}
    </div>
  );
}

function MyListPage({ go }) {
  const { myList, catalog, loaded } = useApp();
  const items = myList.map((x) => catalog.find((c) => c.id === x.id)).filter(Boolean);
  const open = (item) => go(item.type === "series" ? "series-detail" : "movie-detail", item.id);
  if (!loaded) return <LoadingState />;
  return (
    <div className="pt-10 max-w-[1400px] mx-auto px-4 md:px-8 pb-10">
      <h1 className="text-2xl md:text-3xl font-bold mb-6" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>ჩემი სია</h1>
      {items.length === 0 ? (
        <EmptyState icon={ListVideo} title="სია ცარიელია" subtitle="დაამატეთ ფილმები და სერიალები, დააჭირეთ + ღილაკს ბარათზე." />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 md:gap-5">
          {items.map((it) => <TitleCard key={it.id} item={it} onOpen={open} />)}
        </div>
      )}
    </div>
  );
}

function DetailPage({ id, go, isSeries }) {
  const { findById, catalog, isInMyList, toggleMyList, loaded } = useApp();
  const item = findById(id);
  if (!loaded) return <LoadingState />;
  if (!item) return <ErrorState message="სათაური ვერ მოიძებნა." onRetry={() => go("home")} />;

  const similar = catalog.filter((x) => x.id !== item.id && x.genres.some((g) => item.genres.includes(g))).slice(0, 8);
  const saved = isInMyList(item.id);

  return (
    <div className="pb-14">
      <div className="relative w-full" style={{ height: "min(56vh, 480px)" }}>
        <img src={item.backdrop} alt={item.title} className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: "linear-gradient(0deg, rgba(10,13,20,1) 5%, rgba(10,13,20,0.3) 60%, rgba(10,13,20,0.5) 100%)" }} />
        <button onClick={() => go(item.type === "series" ? "series" : "movies")} className="absolute top-6 left-4 md:left-8 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(10,13,20,0.6)" }}>
          <ArrowLeft size={16} color="#fff" />
        </button>
      </div>

      <div className="max-w-[1400px] mx-auto px-4 md:px-8 -mt-24 relative flex flex-col md:flex-row gap-6 md:gap-10">
        <img src={item.poster} alt={item.title} className="w-40 md:w-56 rounded-xl shrink-0 shadow-2xl" style={{ border: `1px solid ${THEME.border}` }} />
        <div className="flex-1 pt-2">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Badge>{item.type === "series" ? "სერიალი" : "ფილმი"}</Badge>
            <Badge>{item.year}</Badge>
            {!isSeries && <Badge><Clock size={11} className="inline mr-1" />{item.duration} წთ</Badge>}
            <Rating value={item.rating} />
          </div>
          <h1 className="text-2xl md:text-4xl font-bold mb-3" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>{item.title}</h1>
          <div className="flex flex-wrap gap-2 mb-4">
            {item.genres.map((g) => <Badge key={g}>{g}</Badge>)}
          </div>
          <p className="text-sm md:text-base leading-relaxed max-w-2xl mb-6" style={{ color: THEME.textMuted }}>{item.description}</p>
          <div className="text-sm mb-6 space-y-1" style={{ color: THEME.textMuted }}>
            <p><span style={{ color: THEME.text }}>რეჟისორი:</span> {item.director}</p>
            <p><span style={{ color: THEME.text }}>მსახიობები:</span> {item.cast.join(", ")}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => go("watch", item.id)}><Play size={16} fill="#181206" /> ყურება</Button>
            <Button variant="ghost" onClick={() => toggleMyList(item.id, item.type)}>
              {saved ? <Check size={16} /> : <Plus size={16} />} {saved ? "სიაშია" : "ჩემს სიაში დამატება"}
            </Button>
          </div>

          {isSeries && <SeasonBrowser item={item} go={go} />}
        </div>
      </div>

      <div className="mt-14">
        <Row title="მსგავსი სათაურები" items={similar} onOpen={(it) => go(it.type === "series" ? "series-detail" : "movie-detail", it.id)} />
      </div>
    </div>
  );
}

function SeasonBrowser({ item, go }) {
  const [seasonIdx, setSeasonIdx] = useState(0);
  const season = item.seasons[seasonIdx];
  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h3 className="text-lg font-semibold" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>ეპიზოდები</h3>
        <select
          value={seasonIdx}
          onChange={(e) => setSeasonIdx(parseInt(e.target.value))}
          className="text-sm px-3 py-2 rounded-lg outline-none"
          style={{ background: THEME.surface, color: THEME.text, border: `1px solid ${THEME.border}` }}
        >
          {item.seasons.map((s, i) => <option key={s.number} value={i}>სეზონი {s.number}</option>)}
        </select>
      </div>
      <div className="space-y-2">
        {season.episodes.map((ep) => (
          <button
            key={ep.id}
            onClick={() => go("watch", item.id, { season: season.number, episode: ep.number })}
            className="w-full flex items-center gap-4 p-3 rounded-xl text-left hover:brightness-110 transition-all"
            style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}
          >
            <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 text-sm font-medium" style={{ background: THEME.surface2, color: THEME.accent }}>
              {ep.number}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium truncate" style={{ color: THEME.text }}>{ep.title}</h4>
              <p className="text-xs mt-0.5 line-clamp-1" style={{ color: THEME.textMuted }}>{ep.description}</p>
            </div>
            <span className="text-xs shrink-0" style={{ color: THEME.textMuted }}>{ep.duration} წთ</span>
            <Play size={16} style={{ color: THEME.accent }} className="shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

function WatchPage({ id, seasonEp, go }) {
  const { findById, pushHistory, loaded } = useApp();
  const item = findById(id);
  const [seasonIdx, setSeasonIdx] = useState(0);
  const [epIdx, setEpIdx] = useState(0);

  useEffect(() => {
    if (item?.type === "series" && seasonEp) {
      const sIdx = item.seasons.findIndex((s) => s.number === seasonEp.season);
      const season = item.seasons[sIdx >= 0 ? sIdx : 0];
      const eIdx = season.episodes.findIndex((e) => e.number === seasonEp.episode);
      setSeasonIdx(sIdx >= 0 ? sIdx : 0);
      setEpIdx(eIdx >= 0 ? eIdx : 0);
    }
  }, [item, seasonEp]);

  if (!loaded) return <LoadingState />;
  if (!item) return <ErrorState message="ვიდეო ვერ მოიძებნა." onRetry={() => go("home")} />;

  const isSeries = item.type === "series";
  const season = isSeries ? item.seasons[seasonIdx] : null;
  const episode = isSeries ? season.episodes[epIdx] : null;

  const goNext = () => {
    if (!isSeries) return;
    if (epIdx < season.episodes.length - 1) {
      setEpIdx(epIdx + 1);
    } else if (seasonIdx < item.seasons.length - 1) {
      setSeasonIdx(seasonIdx + 1);
      setEpIdx(0);
    }
  };

  useEffect(() => {
    pushHistory({ id: item.id, type: item.type, title: item.title, seasonEp: episode ? `${season.number}-${episode.number}` : null });
    // eslint-disable-next-line
  }, [item.id, episode?.id]);

  return (
    <div className="max-w-[1400px] mx-auto px-4 md:px-8 pt-8 pb-14">
      <button onClick={() => go(isSeries ? "series-detail" : "movie-detail", item.id)} className="flex items-center gap-2 mb-4 text-sm" style={{ color: THEME.textMuted }}>
        <ArrowLeft size={15} /> უკან
      </button>
      <VideoPlayer
        item={item}
        seasonNumber={season?.number}
        episode={episode}
        onEnded={goNext}
        onNextEpisode={isSeries ? goNext : null}
        go={go}
      />
      <div className="mt-5">
        <h1 className="text-xl md:text-2xl font-bold" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>
          {item.title}{isSeries && episode ? ` — ს${season.number} ე${episode.number}: ${episode.title}` : ""}
        </h1>
        <p className="text-sm mt-2 max-w-2xl" style={{ color: THEME.textMuted }}>{episode ? episode.description : item.description}</p>
        {isSeries && (
          <div className="mt-6">
            <h3 className="text-sm font-medium mb-3" style={{ color: THEME.text }}>ეპიზოდები — სეზონი {season.number}</h3>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {season.episodes.map((ep, i) => (
                <button
                  key={ep.id}
                  onClick={() => setEpIdx(i)}
                  className="shrink-0 w-40 text-left p-3 rounded-lg"
                  style={{ background: i === epIdx ? THEME.surface2 : THEME.surface, border: `1px solid ${i === epIdx ? THEME.accent : THEME.border}` }}
                >
                  <span className="text-xs" style={{ color: THEME.accent }}>ეპიზოდი {ep.number}</span>
                  <p className="text-xs mt-1 line-clamp-2" style={{ color: THEME.text }}>{ep.title}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AuthLayout({ title, children }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm p-8 rounded-2xl" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
        <h1 className="text-xl font-bold mb-6 text-center" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <label className="block mb-4">
      <span className="text-xs mb-1.5 block" style={{ color: THEME.textMuted }}>{label}</span>
      <input {...props} className="w-full px-3 py-2.5 rounded-lg outline-none text-sm" style={{ background: THEME.bg, border: `1px solid ${THEME.border}`, color: THEME.text }} />
    </label>
  );
}

function LoginPage({ go }) {
  const { login, supabaseReady } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!email || !password) { setError("გთხოვთ შეავსოთ ყველა ველი."); return; }
    setSubmitting(true);
    const res = await login(email.trim(), password);
    setSubmitting(false);
    if (res?.error) { setError(res.error); return; }
    go("profile");
  };
  return (
    <AuthLayout title="შესვლა">
      {!supabaseReady && (
        <p className="text-xs mb-4 px-3 py-2 rounded-lg" style={{ background: "rgba(232,163,61,0.1)", color: THEME.accent }}>
          ავტორიზაცია ჯერ არ არის დაკონფიგურირებული ამ გარემოში — იხილეთ README.md ფაილი Supabase-ის დასაყენებლად.
        </p>
      )}
      <form onSubmit={submit}>
        <Field label="ელფოსტა" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        <Field label="პაროლი" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
        {error && <p className="text-xs mb-3" style={{ color: THEME.danger }}>{error}</p>}
        <Button type="submit" className="w-full justify-center" disabled={submitting}><LogIn size={16} /> {submitting ? "შესვლა..." : "შესვლა"}</Button>
      </form>
      <p className="text-xs text-center mt-5" style={{ color: THEME.textMuted }}>
        არ გაქვთ ანგარიში? <button onClick={() => go("register")} style={{ color: THEME.accent }}>დარეგისტრირდით</button>
      </p>
    </AuthLayout>
  );
}

function RegisterPage({ go }) {
  const { register, supabaseReady } = useApp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!name || !email || !password) { setError("გთხოვთ შეავსოთ ყველა ველი."); return; }
    if (password.length < 6) { setError("პაროლი უნდა შეიცავდეს მინიმუმ 6 სიმბოლოს."); return; }
    setSubmitting(true);
    const res = await register(name.trim(), email.trim(), password);
    setSubmitting(false);
    if (res?.error) { setError(res.error); return; }
    if (res?.needsConfirmation) { setConfirmSent(true); return; }
    go("profile");
  };

  if (confirmSent) {
    return (
      <AuthLayout title="თითქმის მზადაა">
        <p className="text-sm text-center" style={{ color: THEME.textMuted }}>
          გამოგზავნეთ დამადასტურებელი ბმული <span style={{ color: THEME.text }}>{email}</span>-ზე. გახსენით ელფოსტა, დაადასტურეთ ანგარიში და შემდეგ შედით სისტემაში.
        </p>
        <Button className="w-full justify-center mt-5" onClick={() => go("login")}><LogIn size={16} /> შესვლის გვერდზე დაბრუნება</Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="რეგისტრაცია">
      {!supabaseReady && (
        <p className="text-xs mb-4 px-3 py-2 rounded-lg" style={{ background: "rgba(232,163,61,0.1)", color: THEME.accent }}>
          ავტორიზაცია ჯერ არ არის დაკონფიგურირებული ამ გარემოში — იხილეთ README.md ფაილი Supabase-ის დასაყენებლად.
        </p>
      )}
      <form onSubmit={submit}>
        <Field label="სახელი" value={name} onChange={(e) => setName(e.target.value)} placeholder="თქვენი სახელი" autoComplete="name" />
        <Field label="ელფოსტა" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        <Field label="პაროლი" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="მინ. 6 სიმბოლო" autoComplete="new-password" />
        {error && <p className="text-xs mb-3" style={{ color: THEME.danger }}>{error}</p>}
        <Button type="submit" className="w-full justify-center" disabled={submitting}><UserPlus size={16} /> {submitting ? "რეგისტრაცია..." : "რეგისტრაცია"}</Button>
      </form>
      <p className="text-xs text-center mt-5" style={{ color: THEME.textMuted }}>
        უკვე გაქვთ ანგარიში? <button onClick={() => go("login")} style={{ color: THEME.accent }}>შედით</button>
      </p>
    </AuthLayout>
  );
}

function ProfilePage({ go }) {
  const { user, isAdmin, logout, history, catalog } = useApp();
  useEffect(() => { if (!user) go("login"); }, [user]);
  if (!user) return <LoadingState />;
  const recent = history.map((h) => ({ ...h, item: catalog.find((c) => c.id === h.id) })).filter((h) => h.item);
  const doLogout = async () => { await logout(); go("home"); };
  return (
    <div className="max-w-[900px] mx-auto px-4 md:px-8 pt-10 pb-14">
      <div className="flex items-center gap-4 mb-10 flex-wrap">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold" style={{ background: THEME.surface2, color: THEME.accent }}>
          {user.name?.[0]?.toUpperCase()}
        </div>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2" style={{ color: THEME.text }}>
            {user.name}
            {isAdmin && <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "rgba(232,163,61,0.15)", color: THEME.accent }}>ადმინისტრატორი</span>}
          </h1>
          <p className="text-sm" style={{ color: THEME.textMuted }}>{user.email}</p>
        </div>
        <div className="ml-auto flex gap-2">
          {isAdmin && <Button variant="ghost" onClick={() => go("admin")}><LayoutDashboard size={15} /> ადმინ პანელი</Button>}
          <Button variant="outline" onClick={doLogout}>გასვლა</Button>
        </div>
      </div>

      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2" style={{ color: THEME.text }}><History size={17} /> ნახვის ისტორია</h2>
      {recent.length === 0 ? (
        <EmptyState icon={History} title="ისტორია ცარიელია" subtitle="ნანახი ფილმები და სერიალები აქ გამოჩნდება." />
      ) : (
        <div className="space-y-2">
          {recent.map((h, i) => (
            <button key={i} onClick={() => go(h.item.type === "series" ? "series-detail" : "movie-detail", h.item.id)} className="w-full flex items-center gap-3 p-3 rounded-xl text-left" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
              <img src={h.item.poster} className="w-10 h-14 object-cover rounded" />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" style={{ color: THEME.text }}>{h.item.title}</p>
                <p className="text-xs" style={{ color: THEME.textMuted }}>{new Date(h.at).toLocaleString("ka-GE")}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- ADMIN: seasons & episodes editor ---------- */
function SeasonsEditor({ seasons, onChange }) {
  const addSeason = () => {
    const num = seasons.length ? Math.max(...seasons.map((s) => s.number)) + 1 : 1;
    onChange([...seasons, { number: num, episodes: [] }]);
  };
  const removeSeason = (num) => onChange(seasons.filter((s) => s.number !== num));
  const addEpisode = (num) => {
    onChange(seasons.map((s) => (s.number === num ? {
      ...s,
      episodes: [...s.episodes, {
        id: `s${num}e${Date.now()}`,
        number: s.episodes.length + 1,
        title: `ეპიზოდი ${s.episodes.length + 1}`,
        description: "",
        duration: 40,
        videoUrl: DEMO_VIDEO,
      }],
    } : s)));
  };
  const updateEpisode = (num, epId, patch) => {
    onChange(seasons.map((s) => (s.number === num ? { ...s, episodes: s.episodes.map((e) => (e.id === epId ? { ...e, ...patch } : e)) } : s)));
  };
  const removeEpisode = (num, epId) => {
    onChange(seasons.map((s) => (s.number === num ? { ...s, episodes: s.episodes.filter((e) => e.id !== epId).map((e, i) => ({ ...e, number: i + 1 })) } : s)));
  };

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold" style={{ color: THEME.text }}>სეზონები და ეპიზოდები</h4>
        <Button variant="ghost" onClick={addSeason}><Plus size={14} /> სეზონის დამატება</Button>
      </div>
      <div className="space-y-4">
        {seasons.map((season) => (
          <div key={season.number} className="p-4 rounded-lg" style={{ background: THEME.bg, border: `1px solid ${THEME.border}` }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium" style={{ color: THEME.accent }}>სეზონი {season.number}</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => addEpisode(season.number)}><Plus size={13} /> ეპიზოდის დამატება</Button>
                <button onClick={() => removeSeason(season.number)} aria-label="სეზონის წაშლა" className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(193,85,74,0.15)" }}>
                  <Trash2 size={12} style={{ color: "#E58C82" }} />
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {season.episodes.map((ep) => (
                <div key={ep.id} className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_auto] gap-2 items-center p-2 rounded" style={{ background: THEME.surface }}>
                  <input
                    value={ep.title}
                    onChange={(e) => updateEpisode(season.number, ep.id, { title: e.target.value })}
                    placeholder={`ეპიზოდი ${ep.number} — სათაური`}
                    className="px-2 py-2 rounded text-xs outline-none w-full"
                    style={{ background: THEME.bg, border: `1px solid ${THEME.border}`, color: THEME.text }}
                  />
                  <input
                    type="number" min="1" value={ep.duration}
                    onChange={(e) => updateEpisode(season.number, ep.id, { duration: parseInt(e.target.value) || 0 })}
                    placeholder="ხანგრძლ. (წთ)"
                    className="px-2 py-2 rounded text-xs outline-none w-full"
                    style={{ background: THEME.bg, border: `1px solid ${THEME.border}`, color: THEME.text }}
                  />
                  <button onClick={() => removeEpisode(season.number, ep.id)} aria-label="ეპიზოდის წაშლა" className="w-8 h-8 rounded flex items-center justify-center shrink-0" style={{ background: "rgba(193,85,74,0.15)" }}>
                    <Trash2 size={12} style={{ color: "#E58C82" }} />
                  </button>
                </div>
              ))}
              {season.episodes.length === 0 && <p className="text-xs" style={{ color: THEME.textMuted }}>ეპიზოდები არ არის დამატებული.</p>}
            </div>
          </div>
        ))}
        {seasons.length === 0 && <p className="text-xs" style={{ color: THEME.textMuted }}>სეზონები არ არის დამატებული — დააჭირეთ „სეზონის დამატება".</p>}
      </div>
    </div>
  );
}

function emptyMovieForm() {
  return { id: "", title: "", year: 2026, genres: [], rating: 7.5, duration: 100, director: "", cast: "", description: "", poster: "", backdrop: "", videoUrl: DEMO_VIDEO, type: "movie", trending: false, popular: false, newlyAdded: true, recommended: false };
}

function AdminPage({ go }) {
  const { user, isAdmin, movies, series, saveMovieItem, deleteMovieItem, uploadPoster, supabaseReady } = useApp();
  const [tab, setTab] = useState("movies");
  const [editing, setEditing] = useState(null); // form object
  const [editingType, setEditingType] = useState("movie");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  if (!user) {
    return (
      <AuthLayout title="ადმინ პანელი">
        <p className="text-sm text-center mb-5" style={{ color: THEME.textMuted }}>
          ადმინ პანელზე წვდომისთვის საჭიროა ადმინისტრატორის ანგარიშით შესვლა.
        </p>
        {!supabaseReady && (
          <p className="text-xs mb-4 px-3 py-2 rounded-lg" style={{ background: "rgba(232,163,61,0.1)", color: THEME.accent }}>
            ავტორიზაცია ჯერ არ არის დაკონფიგურირებული ამ გარემოში — იხილეთ README.md ფაილი Supabase-ის დასაყენებლად.
          </p>
        )}
        <Button className="w-full justify-center" onClick={() => go("login")}><LogIn size={16} /> შესვლა</Button>
      </AuthLayout>
    );
  }

  if (!isAdmin) {
    return (
      <AuthLayout title="წვდომა შეზღუდულია">
        <p className="text-sm text-center" style={{ color: THEME.textMuted }}>
          თქვენი ანგარიში ({user.email}) არ არის რეგისტრირებული, როგორც ადმინისტრატორი. ეს გვერდი ხელმისაწვდომია მხოლოდ Konoera.ge-ის ადმინისტრატორებისთვის.
        </p>
        <Button variant="outline" className="w-full justify-center mt-5" onClick={() => go("home")}><HomeIcon size={16} /> მთავარ გვერდზე დაბრუნება</Button>
      </AuthLayout>
    );
  }

  const startEdit = (item, type) => {
    setEditingType(type);
    setEditing({ ...item, cast: item.cast.join(", ") });
    setRightsConfirmed(true); // existing, already-published items don't need to be reconfirmed unless the video changes
    setFormError("");
  };
  const startNew = (type) => {
    setEditingType(type);
    const base = emptyMovieForm();
    base.type = type;
    if (type === "series") base.seasons = [];
    setEditing(base);
    setRightsConfirmed(false);
    setFormError("");
  };

  const save = async () => {
    if (!editing.title || !editing.year) { setFormError("გთხოვთ შეავსოთ მინიმუმ სათაური და წელი."); return; }
    if (editing.videoUrl && !rightsConfirmed) {
      setFormError("გთხოვთ დაადასტუროთ, რომ ვიდეო-წყაროს გამოყენების უფლება გაქვთ.");
      return;
    }
    const id = editing.id || `${editingType[0]}${Date.now()}`;
    const cleaned = {
      ...editing,
      id,
      year: parseInt(editing.year) || 2026,
      rating: parseFloat(editing.rating) || 0,
      duration: editingType === "movie" ? (parseInt(editing.duration) || 90) : undefined,
      genres: Array.isArray(editing.genres) ? editing.genres : String(editing.genres).split(",").map((g) => g.trim()).filter(Boolean),
      cast: String(editing.cast).split(",").map((c) => c.trim()).filter(Boolean),
      poster: editing.poster || IMG(id + "-p", 500, 750),
      backdrop: editing.backdrop || IMG(id + "-b", 1600, 900),
      videoUrl: editing.videoUrl || DEMO_VIDEO,
      seasons: editingType === "series" ? (editing.seasons && editing.seasons.length ? editing.seasons : [{ number: 1, episodes: makeEpisodes(1, 4, editing.title || "სერიალი") }]) : undefined,
    };
    setSaving(true);
    setFormError("");
    const res = await saveMovieItem(cleaned);
    setSaving(false);
    if (res?.error) { setFormError(res.error); return; }
    setEditing(null);
  };

  const remove = async (id) => {
    if (!window.confirm("დარწმუნებული ხართ, რომ გსურთ წაშლა?")) return;
    setListError("");
    const res = await deleteMovieItem(id);
    if (res?.error) setListError(res.error);
  };

  const onPosterFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setFormError("");
    const res = await uploadPoster(file, editing.id || editing.title || "poster");
    setUploading(false);
    if (res?.error) { setFormError(res.error); return; }
    setEditing((prev) => ({ ...prev, poster: res.url }));
  };

  const list = tab === "movies" ? movies : series;

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-8 pt-8 pb-16">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.text }}>
          <LayoutDashboard size={22} style={{ color: THEME.accent }} /> ადმინ პანელი
        </h1>
        <p className="text-xs px-3 py-1.5 rounded-full" style={{ background: "rgba(232,163,61,0.12)", color: THEME.accent }}>
          ცვლილებები მყისიერად გამოჩნდება ყველა მომხმარებელთან
        </p>
      </div>

      {listError && <p className="text-xs mb-4 px-3 py-2 rounded-lg" style={{ background: "rgba(193,85,74,0.12)", color: "#E58C82" }}>{listError}</p>}

      <div className="flex gap-2 mb-6 flex-wrap">
        <button onClick={() => { setTab("movies"); setEditing(null); }} className="px-4 py-2 rounded-lg text-sm" style={{ background: tab === "movies" ? THEME.accent : THEME.surface, color: tab === "movies" ? "#181206" : THEME.text }}>ფილმები</button>
        <button onClick={() => { setTab("series"); setEditing(null); }} className="px-4 py-2 rounded-lg text-sm" style={{ background: tab === "series" ? THEME.accent : THEME.surface, color: tab === "series" ? "#181206" : THEME.text }}>სერიალები</button>
        <Button variant="ghost" className="ml-auto" onClick={() => startNew(tab === "movies" ? "movie" : "series")}><Plus size={15} /> დამატება</Button>
      </div>

      {editing && (
        <div className="mb-8 p-5 rounded-xl" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
          <h3 className="text-sm font-semibold mb-4" style={{ color: THEME.text }}>{editing.id ? "რედაქტირება" : "ახალი დამატება"} — {editingType === "movie" ? "ფილმი" : "სერიალი"}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="სათაური" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            <Field label="წელი" type="number" value={editing.year} onChange={(e) => setEditing({ ...editing, year: e.target.value })} />
            <Field label="ჟანრები (მძიმით გამოყოფილი)" value={Array.isArray(editing.genres) ? editing.genres.join(", ") : editing.genres} onChange={(e) => setEditing({ ...editing, genres: e.target.value })} />
            <Field label="რეიტინგი" type="number" step="0.1" value={editing.rating} onChange={(e) => setEditing({ ...editing, rating: e.target.value })} />
            {editingType === "movie" && <Field label="ხანგრძლივობა (წთ)" type="number" value={editing.duration} onChange={(e) => setEditing({ ...editing, duration: e.target.value })} />}
            <Field label="რეჟისორი" value={editing.director} onChange={(e) => setEditing({ ...editing, director: e.target.value })} />
            <Field label="მსახიობები (მძიმით გამოყოფილი)" value={editing.cast} onChange={(e) => setEditing({ ...editing, cast: e.target.value })} />
            <Field label="Backdrop URL" value={editing.backdrop} onChange={(e) => setEditing({ ...editing, backdrop: e.target.value })} placeholder="ცარიელი = ავტომატური" />
          </div>

          <div className="mt-4">
            <span className="text-xs mb-1.5 block" style={{ color: THEME.textMuted }}>პოსტერი</span>
            <div className="flex items-center gap-3 flex-wrap">
              {editing.poster && <img src={editing.poster} alt="პოსტერის გადახედვა" className="w-14 h-20 object-cover rounded-lg" style={{ border: `1px solid ${THEME.border}` }} />}
              <input value={editing.poster || ""} onChange={(e) => setEditing({ ...editing, poster: e.target.value })} placeholder="პოსტერის URL — ცარიელი = ავტომატური" className="flex-1 min-w-[180px] px-3 py-2.5 rounded-lg outline-none text-sm" style={{ background: THEME.bg, border: `1px solid ${THEME.border}`, color: THEME.text }} />
              <label className="px-3 py-2.5 rounded-lg text-xs cursor-pointer shrink-0" style={{ background: THEME.surface2, border: `1px solid ${THEME.border}`, color: THEME.text }}>
                {uploading ? "იტვირთება..." : "ატვირთვა"}
                <input type="file" accept="image/*" className="hidden" onChange={onPosterFile} disabled={uploading || !supabaseReady} />
              </label>
            </div>
            {!supabaseReady && <p className="text-[11px] mt-1.5" style={{ color: THEME.textMuted }}>ფაილის ატვირთვისთვის საჭიროა Supabase-ის დაკონფიგურირება — ან ჯერჯერობით გამოიყენეთ URL ველი.</p>}
          </div>

          <div className="mt-4">
            <Field label="ვიდეო-წყაროს URL" value={editing.videoUrl} onChange={(e) => { setEditing({ ...editing, videoUrl: e.target.value }); setRightsConfirmed(false); }} placeholder="https://..." />
            <label className="flex items-start gap-2 mt-1 cursor-pointer">
              <input type="checkbox" checked={rightsConfirmed} onChange={(e) => setRightsConfirmed(e.target.checked)} className="mt-0.5" />
              <span className="text-xs" style={{ color: THEME.textMuted }}>ვადასტურებ, რომ ამ ვიდეო-წყაროს გამოყენების კანონიერი უფლება მაქვს (საკუთარი კონტენტი, ლიცენზირებული ან საჯარო დომენის მასალა).</span>
            </label>
          </div>

          <label className="block mt-4 mb-1">
            <span className="text-xs mb-1.5 block" style={{ color: THEME.textMuted }}>აღწერა</span>
            <textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={3} className="w-full px-3 py-2.5 rounded-lg outline-none text-sm" style={{ background: THEME.bg, border: `1px solid ${THEME.border}`, color: THEME.text }} />
          </label>
          {editingType === "series" && (
            <SeasonsEditor seasons={editing.seasons || []} onChange={(seasons) => setEditing({ ...editing, seasons })} />
          )}
          {formError && <p className="text-xs mt-4" style={{ color: THEME.danger }}>{formError}</p>}
          <div className="flex gap-3 mt-5">
            <Button onClick={save} disabled={saving}><Save size={15} /> {saving ? "ინახება..." : "შენახვა"}</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>გაუქმება</Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {list.map((it) => (
          <div key={it.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: THEME.surface, border: `1px solid ${THEME.border}` }}>
            <img src={it.poster} className="w-10 h-14 object-cover rounded" />
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate" style={{ color: THEME.text }}>{it.title}</p>
              <p className="text-xs" style={{ color: THEME.textMuted }}>{it.year} · {it.genres.join(", ")}</p>
            </div>
            <button onClick={() => startEdit(it, tab === "movies" ? "movie" : "series")} aria-label="რედაქტირება" className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: THEME.surface2 }}><Pencil size={14} style={{ color: THEME.text }} /></button>
            <button onClick={() => remove(it.id)} aria-label="წაშლა" className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(193,85,74,0.15)" }}><Trash2 size={14} style={{ color: "#E58C82" }} /></button>
          </div>
        ))}
        {list.length === 0 && <EmptyState icon={tab === "movies" ? Film : Tv} title="ჯერ არაფერია დამატებული" subtitle='დააჭირეთ "დამატება", რომ პირველი ჩანაწერი შექმნათ.' />}
      </div>
    </div>
  );
}

function NotFoundPage({ go }) {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 text-center">
      <span className="text-6xl font-bold mb-4" style={{ fontFamily: "'Noto Serif Georgian', serif", color: THEME.accent }}>404</span>
      <h1 className="text-xl font-semibold mb-2" style={{ color: THEME.text }}>გვერდი ვერ მოიძებნა</h1>
      <p className="text-sm mb-6 max-w-sm" style={{ color: THEME.textMuted }}>საძიებელი გვერდი აღარ არსებობს ან გადატანილია.</p>
      <Button onClick={() => go("home")}><HomeIcon size={16} /> მთავარ გვერდზე დაბრუნება</Button>
    </div>
  );
}

/* =========================================================================
   ROOT APP (routing)
========================================================================= */
/* ---------- URL <-> route mapping (real, bookmarkable URLs) ---------- */
function pathFromRoute(route, searchQuery) {
  switch (route.name) {
    case "home": return "/";
    case "movies": return "/movies";
    case "series": return "/series";
    case "series-detail": return `/series/${route.id}`;
    case "movie-detail": return `/movie/${route.id}`;
    case "genres": return "/genres";
    case "genre-detail": return `/genres/${encodeURIComponent(route.id)}`;
    case "search": return searchQuery ? `/search?q=${encodeURIComponent(searchQuery)}` : "/search";
    case "mylist": return "/my-list";
    case "watch": {
      let p = `/watch/${route.id}`;
      if (route.params?.season && route.params?.episode) p += `?s=${route.params.season}&e=${route.params.episode}`;
      return p;
    }
    case "login": return "/login";
    case "register": return "/register";
    case "profile": return "/profile";
    case "admin": return "/admin";
    default: return "/404";
  }
}

function parseLocation() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const search = new URLSearchParams(window.location.search);
  const [seg, arg] = parts;
  if (!seg) return { route: { name: "home", id: null, params: null }, query: "" };
  switch (seg) {
    case "movies": return { route: { name: "movies", id: null, params: null }, query: "" };
    case "series": return { route: arg ? { name: "series-detail", id: arg, params: null } : { name: "series", id: null, params: null }, query: "" };
    case "movie": return { route: { name: "movie-detail", id: arg, params: null }, query: "" };
    case "genres": return { route: arg ? { name: "genre-detail", id: decodeURIComponent(arg), params: null } : { name: "genres", id: null, params: null }, query: "" };
    case "search": return { route: { name: "search", id: null, params: null }, query: search.get("q") || "" };
    case "my-list": return { route: { name: "mylist", id: null, params: null }, query: "" };
    case "watch": {
      const s = parseInt(search.get("s")), e = parseInt(search.get("e"));
      return { route: { name: "watch", id: arg, params: s && e ? { season: s, episode: e } : null }, query: "" };
    }
    case "login": return { route: { name: "login", id: null, params: null }, query: "" };
    case "register": return { route: { name: "register", id: null, params: null }, query: "" };
    case "profile": return { route: { name: "profile", id: null, params: null }, query: "" };
    case "admin": return { route: { name: "admin", id: null, params: null }, query: "" };
    default: return { route: { name: "notfound", id: null, params: null }, query: "" };
  }
}

const META_SUFFIX = " — Konoera.ge";
function updateHeadMeta(route, findById) {
  let title = "Konoera.ge — ქართული ფილმები და სერიალები ონლაინ";
  let desc = "Konoera.ge — ქართული ფილმებისა და სერიალების სტრიმინგ-კატალოგი. უყურეთ საუკეთესო ქართულ კონტენტს ონლაინ.";
  switch (route.name) {
    case "movies": title = "ფილმები" + META_SUFFIX; desc = "დაათვალიერეთ ქართული ფილმების სრული კატალოგი, ჟანრებისა და წლების მიხედვით."; break;
    case "series": title = "სერიალები" + META_SUFFIX; desc = "დაათვალიერეთ ქართული სერიალების სრული კატალოგი სეზონებითა და ეპიზოდებით."; break;
    case "genres": title = "ჟანრები" + META_SUFFIX; desc = "დაათვალიერეთ ფილმები და სერიალები ჟანრების მიხედვით."; break;
    case "genre-detail": title = route.id + META_SUFFIX; desc = `${route.id} ჟანრის ფილმები და სერიალები Konoera.ge-ზე.`; break;
    case "search": title = "ძებნა" + META_SUFFIX; desc = "მოძებნეთ ფილმები და სერიალები Konoera.ge-ის კატალოგში."; break;
    case "mylist": title = "ჩემი სია" + META_SUFFIX; desc = "თქვენს მიერ შენახული ფილმები და სერიალები."; break;
    case "login": title = "შესვლა" + META_SUFFIX; break;
    case "register": title = "რეგისტრაცია" + META_SUFFIX; break;
    case "profile": title = "პროფილი" + META_SUFFIX; break;
    case "admin": title = "ადმინ პანელი" + META_SUFFIX; break;
    case "notfound": title = "გვერდი ვერ მოიძებნა" + META_SUFFIX; desc = "საძიებელი გვერდი აღარ არსებობს ან გადატანილია."; break;
    case "movie-detail":
    case "series-detail":
    case "watch": {
      const item = findById(route.id);
      if (item) {
        title = `${item.title} (${item.year})` + META_SUFFIX;
        desc = (item.description || desc).slice(0, 160);
      }
      break;
    }
    default: break;
  }
  document.title = title;
  let m = document.querySelector('meta[name="description"]');
  if (!m) { m = document.createElement("meta"); m.setAttribute("name", "description"); document.head.appendChild(m); }
  m.setAttribute("content", desc);
}

function AppInner() {
  const { findById, loaded } = useApp();
  const initial = useRef(parseLocation());
  const [route, setRoute] = useState(initial.current.route);
  const [query, setQuery] = useState(initial.current.query);
  const [pageLoading, setPageLoading] = useState(false);

  const go = useCallback((name, id = null, params = null) => {
    setPageLoading(true);
    window.scrollTo(0, 0);
    setTimeout(() => {
      setRoute({ name, id, params });
      setPageLoading(false);
    }, 120);
  }, []);

  // keep the address bar in sync with in-app navigation
  useEffect(() => {
    const path = pathFromRoute(route, route.name === "search" ? query : undefined);
    if (window.location.pathname + window.location.search !== path) {
      window.history.pushState({}, "", path);
    }
    updateHeadMeta(route, findById);
  }, [route, query, findById]);

  // support browser back/forward buttons
  useEffect(() => {
    const onPopState = () => {
      const parsed = parseLocation();
      setRoute(parsed.route);
      setQuery(parsed.query);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const onSearchSubmit = () => go("search");

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: THEME.bg }}>
        <LoadingState label="Konoera.ge იტვირთება..." />
      </div>
    );
  }

  let page = null;
  switch (route.name) {
    case "home": page = <HomePage go={go} />; break;
    case "movies": page = <MoviesRouted go={go} />; break;
    case "series": page = <SeriesRouted go={go} />; break;
    case "genres": page = <GenresPage go={go} />; break;
    case "genre-detail": page = <GenreDetailPage genre={route.id} go={go} />; break;
    case "search": page = <SearchPage go={go} query={query} setQuery={setQuery} />; break;
    case "mylist": page = <MyListPage go={go} />; break;
    case "movie-detail": page = <DetailPage id={route.id} go={go} isSeries={false} />; break;
    case "series-detail": page = <DetailPage id={route.id} go={go} isSeries={true} />; break;
    case "watch": page = <WatchPage id={route.id} seasonEp={route.params} go={go} />; break;
    case "login": page = <LoginPage go={go} />; break;
    case "register": page = <RegisterPage go={go} />; break;
    case "profile": page = <ProfilePage go={go} />; break;
    case "admin": page = <AdminPage go={go} />; break;
    default: page = <NotFoundPage go={go} />;
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: THEME.bg, color: THEME.text, fontFamily: "'Noto Sans Georgian', sans-serif" }}>
      <Navbar route={route} go={go} query={query} setQuery={setQuery} onSearchSubmit={onSearchSubmit} />
      <main className="flex-1">{pageLoading ? <LoadingState /> : page}</main>
      <Footer go={go} />
    </div>
  );
}

function MoviesRouted({ go }) {
  const { movies, loaded } = useApp();
  if (!loaded) return <LoadingState />;
  return <GridPage title="ფილმები" items={movies} go={go} type="movie" />;
}
function SeriesRouted({ go }) {
  const { series, loaded } = useApp();
  if (!loaded) return <LoadingState />;
  return <GridPage title="სერიალები" items={series} go={go} type="series" />;
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
