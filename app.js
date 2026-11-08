const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const view = params.get("vista") || "inicio";
const color = params.get("color") || "";
const supabaseConfig = window.RETO_SUPABASE_CONFIG || {};
const supabaseClient = window.supabase && supabaseConfig.url && supabaseConfig.anonKey
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
    : null;
let pollHandle = null;
let clockHandle = null;
let currentAdminState = null;
let setupDirty = false;
let timerDeadline = 0;
let timerRemaining = 0;
let timerRunning = false;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
}[character]));

async function api(action, payload = null, query = {}) {
    if (!supabaseClient) {
        throw new Error("Falta configurar Supabase. Sigue los pasos de instalación del README.");
    }

    const checked = ({ data, error }) => {
        if (error) throw new Error(error.message);
        return data;
    };
    const runQuery = async (request) => checked(await request);
    const getAdminStatus = async () => {
        const session = checked(await supabaseClient.auth.getSession()).session;
        if (!session) return { is_admin: false };
        const admins = checked(await supabaseClient.from("admin_users").select("user_id").eq("user_id", session.user.id));
        return { is_admin: admins.length > 0 };
    };
    const getTimer = async () => {
        const row = checked(await supabaseClient.from("dynamics").select("*").eq("id", 1).single());
        const remaining = row.is_running && row.ends_at
            ? Math.max(0, Math.ceil((Date.parse(row.ends_at) - Date.now()) / 1000))
            : Number(row.remaining_seconds);
        return {
            duration_seconds: Number(row.duration_seconds),
            remaining_seconds: remaining,
            is_running: Boolean(row.is_running) && remaining > 0,
            active_team: row.active_team,
            active_station: row.active_station === null ? null : Number(row.active_station),
        };
    };
    const getAdminState = async () => {
        const [teams, stations, questions, answers, hints, releases, access, requests, timer] = await Promise.all([
            runQuery(supabaseClient.from("teams").select("*").order("sort_order")),
            runQuery(supabaseClient.from("stations").select("*").order("sort_order")),
            runQuery(supabaseClient.from("station_questions").select("*")),
            runQuery(supabaseClient.from("station_answers").select("*")),
            runQuery(supabaseClient.from("hints").select("*")),
            runQuery(supabaseClient.from("hint_releases").select("*")),
            runQuery(supabaseClient.from("hint_access").select("*")),
            runQuery(supabaseClient.from("hint_requests").select("*")),
            getTimer(),
        ]);
        for (const station of stations) {
            station.question = questions.find((item) => Number(item.station_id) === Number(station.id))?.question || "";
            station.options = questions.find((item) => Number(item.station_id) === Number(station.id))?.options || [];
            const answer = answers.find((item) => Number(item.station_id) === Number(station.id));
            station.correct_option = answer?.correct_option === null || !answer ? null : Number(answer.correct_option);
        }
        for (const team of teams) {
            team.hints = {};
            for (const station of stations) {
                const hint = hints.find((item) => item.team_slug === team.slug && Number(item.station_id) === Number(station.id));
                const release = releases.find((item) => item.team_slug === team.slug && Number(item.station_id) === Number(station.id));
                const hintAccess = access.find((item) => item.team_slug === team.slug && Number(item.station_id) === Number(station.id));
                const request = requests.find((item) => item.team_slug === team.slug && Number(item.station_id) === Number(station.id));
                team.hints[station.id] = {
                    content: hint?.content || "",
                    is_unlocked: Boolean(release?.is_unlocked),
                    enabled: Boolean(hintAccess?.enabled),
                    requested: Boolean(request?.requested),
                };
            }
        }
        return { teams, stations, timer, is_admin: true };
    };

    if (action === "admin_status") return getAdminStatus();
    if (action === "login") {
        checked(await supabaseClient.auth.signInWithPassword({
            email: String(payload.email || ""),
            password: String(payload.password || ""),
        }));
        return { ok: true };
    }
    if (action === "logout") {
        checked(await supabaseClient.auth.signOut());
        return { ok: true };
    }
    if (action === "state") {
        const adminStatus = await getAdminStatus();
        if (adminStatus.is_admin && !query.color) return getAdminState();
        const team = checked(await supabaseClient.from("teams").select("*").eq("slug", query.color || "").maybeSingle());
        if (!team) throw new Error("No encontramos ese grupo.");
        const [stations, questions, releases, hints, access, requests, timer] = await Promise.all([
            runQuery(supabaseClient.from("stations").select("*").order("sort_order")),
            runQuery(supabaseClient.from("station_questions").select("*").eq("team_slug", team.slug)),
            runQuery(supabaseClient.from("hint_releases").select("*").eq("team_slug", team.slug)),
            runQuery(supabaseClient.from("hints").select("*").eq("team_slug", team.slug)),
            runQuery(supabaseClient.from("hint_access").select("*").eq("team_slug", team.slug)),
            runQuery(supabaseClient.from("hint_requests").select("*").eq("team_slug", team.slug)),
            getTimer(),
        ]);
        return {
            team,
            timer,
            stations: stations.map((station) => {
                const release = releases.find((item) => Number(item.station_id) === Number(station.id));
                const hint = hints.find((item) => Number(item.station_id) === Number(station.id));
                const hintAccess = access.find((item) => Number(item.station_id) === Number(station.id));
                const request = requests.find((item) => Number(item.station_id) === Number(station.id));
                const question = questions.find((item) => Number(item.station_id) === Number(station.id));
                const enabled = Boolean(hintAccess?.enabled);
                return {
                    ...station,
                    question: enabled ? question?.question || "" : "",
                    options: enabled ? question?.options || [] : [],
                    hint_enabled: enabled,
                    hint_requested: Boolean(request?.requested),
                    hint: release?.is_unlocked ? hint?.content || "" : "",
                    is_unlocked: Boolean(release?.is_unlocked),
                };
            }),
        };
    }

    if (action === "request_hint") {
        const hintAccess = checked(await supabaseClient.from("hint_access").select("enabled")
            .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id).maybeSingle());
        if (!hintAccess?.enabled) throw new Error("Esta estación todavía no ha habilitado las preguntas.");
        const release = checked(await supabaseClient.from("hint_releases").select("is_unlocked")
            .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id).maybeSingle());
        if (release?.is_unlocked) throw new Error("La pista de esta estación ya está disponible.");
        checked(await supabaseClient.from("hint_requests").update({
            requested: true,
            requested_at: new Date().toISOString(),
        }).eq("team_slug", payload.team_slug).eq("station_id", payload.station_id));
        return { ok: true };
    }

    const adminStatus = await getAdminStatus();
    if (!adminStatus.is_admin) throw new Error("Inicia sesión como amarillo para realizar esta acción.");

    if (action === "save_setup") {
        for (const station of payload.stations || []) {
            if (!station.name.trim()) throw new Error("Cada estación debe tener un nombre.");
        }
        for (const team of payload.teams || []) {
            checked(await supabaseClient.from("teams").update({ topic: team.topic.trim() }).eq("slug", team.slug));
        }
        for (const station of payload.stations || []) {
            checked(await supabaseClient.from("stations").update({
                name: station.name.trim(),
                format: station.format.trim(),
                facilitator_question: station.facilitator_question.trim(),
            }).eq("id", station.id));
            checked(await supabaseClient.from("station_questions").update({
                question: station.question.trim(),
                options: station.options.map((option) => option.trim()),
            }).eq("station_id", station.id));
            checked(await supabaseClient.from("station_answers").update({
                correct_option: Number(station.correct_option),
            }).eq("station_id", station.id));
        }
        for (const hint of payload.hints || []) {
            checked(await supabaseClient.from("hints").update({ content: hint.content.trim() })
                .eq("team_slug", hint.team_slug).eq("station_id", hint.station_id));
        }
        return { ok: true };
    }
    if (action === "set_hint_access") {
        checked(await supabaseClient.from("hint_access").update({ enabled: Boolean(payload.enabled) })
            .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id));
        if (!payload.enabled) {
            checked(await supabaseClient.from("hint_requests").update({ requested: false, requested_at: null })
                .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id));
        }
        return { ok: true };
    }
    if (action === "clear_hint_request") {
        checked(await supabaseClient.from("hint_requests").update({ requested: false, requested_at: null })
            .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id));
        return { ok: true };
    }
    if (action === "focus") {
        checked(await supabaseClient.from("dynamics").update({
            active_team: payload.team_slug,
            active_station: payload.station_id,
        }).eq("id", 1));
        return { ok: true };
    }
    if (action === "release_hint") {
        const hint = checked(await supabaseClient.from("hints").select("content")
            .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id).maybeSingle());
        if (!hint?.content?.trim()) throw new Error("Escribe y guarda la pista antes de liberarla.");
        const [access, request] = await Promise.all([
            runQuery(supabaseClient.from("hint_access").select("enabled")
                .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id).maybeSingle()),
            runQuery(supabaseClient.from("hint_requests").select("requested")
                .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id).maybeSingle()),
        ]);
        if (!access?.enabled || !request?.requested) throw new Error("Espera a que el grupo solicite la pista.");
        checked(await supabaseClient.from("hint_releases").update({
            is_unlocked: true,
            unlocked_at: new Date().toISOString(),
        }).eq("team_slug", payload.team_slug).eq("station_id", payload.station_id));
        checked(await supabaseClient.from("hint_requests").update({ requested: false, requested_at: null })
            .eq("team_slug", payload.team_slug).eq("station_id", payload.station_id));
        checked(await supabaseClient.from("dynamics").update({
            active_team: payload.team_slug,
            active_station: payload.station_id,
        }).eq("id", 1));
        return { ok: true };
    }
    if (action === "timer") {
        const row = checked(await supabaseClient.from("dynamics").select("*").eq("id", 1).single());
        const now = Date.now();
        let changes;
        if (payload.operation === "set") {
            const duration = Math.max(60, Math.min(3600, Number(payload.duration_seconds) || 300));
            changes = { duration_seconds: duration, remaining_seconds: duration, ends_at: null, is_running: false };
        } else if (payload.operation === "start") {
            const remaining = row.is_running && row.ends_at
                ? Math.max(0, Math.ceil((Date.parse(row.ends_at) - now) / 1000))
                : Number(row.remaining_seconds);
            changes = {
                remaining_seconds: remaining,
                ends_at: remaining > 0 ? new Date(now + remaining * 1000).toISOString() : null,
                is_running: remaining > 0,
            };
        } else if (payload.operation === "pause") {
            const remaining = row.is_running && row.ends_at
                ? Math.max(0, Math.ceil((Date.parse(row.ends_at) - now) / 1000))
                : Number(row.remaining_seconds);
            changes = { remaining_seconds: remaining, ends_at: null, is_running: false };
        } else if (payload.operation === "reset") {
            changes = { remaining_seconds: row.duration_seconds, ends_at: null, is_running: false };
        } else {
            throw new Error("Acción de temporizador desconocida.");
        }
        checked(await supabaseClient.from("dynamics").update(changes).eq("id", 1));
        return { ok: true };
    }
    if (action === "reset_progress") {
        const timer = checked(await supabaseClient.from("dynamics").select("duration_seconds").eq("id", 1).single());
        checked(await supabaseClient.from("hint_releases").update({ is_unlocked: false, unlocked_at: null })
            .neq("team_slug", ""));
        checked(await supabaseClient.from("hint_requests").update({ requested: false, requested_at: null })
            .neq("team_slug", ""));
        checked(await supabaseClient.from("hint_access").update({ enabled: false }).neq("team_slug", ""));
        checked(await supabaseClient.from("dynamics").update({
            remaining_seconds: timer.duration_seconds,
            ends_at: null,
            is_running: false,
            active_team: null,
            active_station: null,
        }).eq("id", 1));
        return { ok: true };
    }
    throw new Error("Acción desconocida.");
}

function notify(message, type = "success") {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast toast-${type} visible`;
    window.clearTimeout(notify.timeout);
    notify.timeout = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function formatTime(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
    const remainder = (safeSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
}

function syncClock(timer) {
    timerRemaining = Math.max(0, Number(timer.remaining_seconds) || 0);
    timerRunning = Boolean(timer.is_running) && timerRemaining > 0;
    timerDeadline = Date.now() + timerRemaining * 1000;
    updateClocks();
    if (clockHandle === null) clockHandle = window.setInterval(updateClocks, 250);
}

function updateClocks() {
    const remaining = timerRunning
        ? Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000))
        : timerRemaining;
    if (remaining === 0) timerRunning = false;
    const display = formatTime(remaining);
    const adminTimer = document.querySelector("#admin-timer");
    if (adminTimer) adminTimer.textContent = display;
    const teamTimer = document.querySelector("#team-timer");
    if (teamTimer) teamTimer.textContent = display;
    const adminState = document.querySelector("#timer-state");
    if (adminState) adminState.textContent = timerRunning ? "Temporizador en marcha" : remaining === 0 ? "Tiempo terminado" : "Temporizador detenido";
    const teamState = document.querySelector("#team-timer-state");
    if (teamState) teamState.textContent = timerRunning ? "Ronda en marcha" : remaining === 0 ? "Tiempo terminado" : "Ronda en pausa";
}

function renderLanding() {
    const teams = [
        { slug: "salmones", name: "Los salmones", color: "#df866f", note: "Vista del grupo" },
        { slug: "verdes", name: "Los verdes", color: "#4b8b68", note: "Vista del grupo" },
        { slug: "azules", name: "Los azules", color: "#5278a9", note: "Vista del grupo" },
    ];
    app.innerHTML = `
        <section class="landing">
            <div class="eyebrow">DINÁMICA COLABORATIVA</div>
            <h1>Reto de <span>investigación</span></h1>
            <p class="lead">Una investigación, cinco estaciones y pistas que se desbloquean al responder correctamente.</p>
            <div class="landing-grid">
                <a class="portal-card portal-admin" href="?vista=amarillos">
                    <span class="portal-icon">✳</span>
                    <span class="portal-name">Vista amarilla</span>
                    <span class="portal-note">Administrar la dinámica</span>
                    <span class="portal-arrow">↗</span>
                </a>
                ${teams.map((team) => `
                    <a class="portal-card portal-team" href="?vista=grupo&color=${team.slug}" style="--team-color:${team.color}">
                        <span class="portal-icon">●</span>
                        <span class="portal-name">${team.name}</span>
                        <span class="portal-note">${team.note}</span>
                        <span class="portal-arrow">↗</span>
                    </a>
                `).join("")}
            </div>
            <p class="landing-footnote">Los colores identifican las vistas; todos los grupos tienen las mismas oportunidades.</p>
        </section>`;
}

function renderLogin(error = "") {
    app.innerHTML = `
        <section class="login-wrap">
            <a class="back-link" href="./">← Inicio</a>
            <div class="login-card">
                <div class="eyebrow">PANEL DE CONTROL · AMARILLOS</div>
                <h1>Organiza la dinámica</h1>
                <p class="muted">Inicia sesión para asignar temas, preparar pistas y controlar las estaciones.</p>
                <form id="login-form">
                    <label for="admin-email">Correo de administración</label>
                    <input id="admin-email" name="email" type="email" autocomplete="username" required autofocus>
                    <label for="admin-password">Contraseña</label>
                    <input id="admin-password" name="password" type="password" autocomplete="current-password" required>
                    ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
                    <button class="button button-dark button-wide" type="submit">Entrar al panel <span>→</span></button>
                </form>
                <p class="small-muted">Usa la cuenta de administración creada en Supabase.</p>
            </div>
        </section>
        <div id="toast" class="toast" role="status" aria-live="polite"></div>`;
    document.querySelector("#login-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector("button");
        button.disabled = true;
        try {
            await api("login", {
                email: new FormData(event.currentTarget).get("email"),
                password: new FormData(event.currentTarget).get("password"),
            });
            setupDirty = false;
            await loadAdmin();
        } catch (error) {
            renderLogin(error.message);
        }
    });
}

function renderAdmin(state) {
    currentAdminState = state;
    syncClock(state.timer);
    const timer = state.timer;
    const durationMinutes = Math.round(timer.duration_seconds / 60);
    const activeTeam = state.teams.find((team) => team.slug === timer.active_team)?.slug || state.teams[0]?.slug || "";
    const activeStation = timer.active_station || state.stations[0]?.id || "";
    app.innerHTML = `
        <div class="admin-page">
            <header class="topbar">
                <a class="brand" href="./"><span class="brand-mark">✳</span> Reto de investigación</a>
                <div class="topbar-actions"><span class="role-pill">● Vista amarilla</span><button class="button button-quiet" id="logout-button">Salir</button></div>
            </header>
            <section class="admin-heading">
                <div><div class="eyebrow">CENTRO DE CONTROL</div><h1>La dinámica, en tus manos.</h1><p>Prepara temas y pistas; libera cada pista cuando el grupo responda bien.</p></div>
                <button class="button button-outline" id="reset-button">↻ Reiniciar dinámica</button>
            </section>
            <section class="control-grid">
                <article class="control-card timer-card">
                    <div class="section-kicker">01 · TIEMPO</div>
                    <div class="timer-display" id="admin-timer">${formatTime(timer.remaining_seconds)}</div>
                    <div class="timer-state" id="timer-state">${timer.is_running ? "Temporizador en marcha" : "Temporizador detenido"}</div>
                    <div class="timer-actions">
                        <button class="button button-dark" id="timer-toggle">${timer.is_running ? "Pausar" : "Iniciar"} <span>${timer.is_running ? "Ⅱ" : "▶"}</span></button>
                        <button class="button button-outline" id="timer-reset">Reiniciar reloj</button>
                    </div>
                    <div class="duration-control"><label for="timer-duration">Duración</label><div class="duration-input"><input id="timer-duration" type="number" min="1" max="60" value="${durationMinutes}"><span>min</span><button class="button button-small" id="duration-save">Aplicar</button></div></div>
                </article>
                <article class="control-card focus-card">
                    <div class="section-kicker">02 · ESTACIÓN ACTIVA</div>
                    <h2>¿A quién estás atendiendo?</h2>
                    <p class="muted">Selecciona un grupo y una estación para tenerlos a mano.</p>
                    <label for="focus-team">Grupo</label>
                    <select id="focus-team">${state.teams.map((team) => `<option value="${escapeHtml(team.slug)}" ${team.slug === activeTeam ? "selected" : ""}>${escapeHtml(team.name)}</option>`).join("")}</select>
                    <label for="focus-station">Estación</label>
                    <select id="focus-station">${state.stations.map((station) => `<option value="${station.id}" ${Number(station.id) === Number(activeStation) ? "selected" : ""}>${escapeHtml(station.name)}</option>`).join("")}</select>
                    <button class="button button-outline button-wide" id="focus-save">Guardar estación activa</button>
                </article>
            </section>
            <section class="setup-section">
                <div class="section-heading"><div><div class="section-kicker">03 · PREPARACIÓN</div><h2>Temas, estaciones y pistas</h2><p>Crea pistas útiles para el tema de cada grupo y la sección que están trabajando.</p></div><button class="button button-dark" id="save-setup">Guardar preparación <span>↓</span></button></div>
                <div class="teams-setup">${state.teams.map((team) => renderTeamSetup(team, state.stations)).join("")}</div>
                <div class="station-setup"><div class="subsection-title"><h3>Estaciones</h3><span>5 paradas · editables</span></div>
                    <div class="station-editor-list">${state.stations.map((station) => `
                        <article class="station-editor">
                            <span class="station-number">${String(station.sort_order).padStart(2, "0")}</span>
                            <div class="station-fields">
                                <label>Nombre de la estación<input class="station-name" data-id="${station.id}" value="${escapeHtml(station.name)}"></label>
                                <label>Formato creativo<input class="station-format" data-id="${station.id}" value="${escapeHtml(station.format)}"></label>
                                <label>Pregunta para quien facilita<textarea class="station-question" data-id="${station.id}" rows="2">${escapeHtml(station.facilitator_question)}</textarea></label>
                                <label class="quiz-question-label">Pregunta para el grupo<textarea class="quiz-question" data-id="${station.id}" rows="2">${escapeHtml(station.question)}</textarea></label>
                                ${[0, 1, 2, 3].map((index) => `<label>Opción ${String.fromCharCode(65 + index)}<input class="quiz-option" data-id="${station.id}" data-option="${index}" value="${escapeHtml(station.options[index] || "")}"></label>`).join("")}
                                <label>Respuesta correcta
                                    <select class="quiz-correct" data-id="${station.id}">
                                        <option value="" ${station.correct_option === null ? "selected" : ""}>Selecciona la correcta</option>
                                        ${[0, 1, 2, 3].map((index) => `<option value="${index}" ${station.correct_option === index ? "selected" : ""}>Opción ${String.fromCharCode(65 + index)}</option>`).join("")}
                                    </select>
                                </label>
                            </div>
                        </article>`).join("")}
                    </div>
                </div>
            </section>
            <section class="release-section">
                <div class="section-heading"><div><div class="section-kicker">04 · ENTREGA DE PISTAS</div><h2>Libera cuando respondan bien</h2><p>La pista aparece al instante en la vista del grupo correspondiente.</p></div></div>
                <div class="release-grid">${state.teams.map((team) => `
                    <article class="release-card" style="--team-color:${escapeHtml(team.color)}">
                        <div class="release-team"><span class="team-dot"></span><h3>${escapeHtml(team.name)}</h3></div>
                        <p class="release-topic">${escapeHtml(team.topic || "Aún no se ha asignado un tema.")}</p>
                        <div class="release-list">${state.stations.map((station) => {
                            const hint = team.hints?.[station.id];
                            const unlocked = hint?.is_unlocked;
                            const hasHint = Boolean(hint?.content?.trim());
                            const requested = hint?.requested;
                            const enabled = hint?.enabled;
                            const answer = station.correct_option === null
                                ? "Selecciona la respuesta correcta en Preparación."
                                : station.options[station.correct_option];
                            return `<article class="release-station">
                                <div class="release-row">
                                    <span><strong>${escapeHtml(station.name)}</strong><small>${unlocked ? "Pista entregada" : requested ? "El grupo solicita su pista" : enabled ? (hasHint ? "Pregunta habilitada" : "Escribe primero la pista") : "Pregunta deshabilitada"}</small></span>
                                    <button class="button button-small" data-access="${escapeHtml(team.slug)}" data-station="${station.id}" data-enabled="${enabled ? "true" : "false"}" ${(unlocked || (!enabled && (!hasHint || station.correct_option === null))) ? "disabled" : ""}>${enabled ? "Deshabilitar" : station.correct_option === null ? "Configura la respuesta" : hasHint ? "Habilitar pregunta" : "Escribe la pista"}</button>
                                </div>
                                ${enabled ? `<div class="facilitator-answer"><strong>Pregunta:</strong> ${escapeHtml(station.question)}<p><strong>Respuesta correcta:</strong> ${escapeHtml(answer)}</p></div>` : ""}
                                ${requested && !unlocked ? `<button class="button button-dark release-action" data-release="${escapeHtml(team.slug)}" data-station="${station.id}" ${!hasHint ? "disabled" : ""}>${hasHint ? "Respuesta correcta: liberar pista" : "Escribe la pista antes de liberarla"}</button>` : ""}
                                ${requested && !unlocked ? `<button class="text-button retry-action" data-clear-request="${escapeHtml(team.slug)}" data-station="${station.id}">Respuesta incorrecta · permitir otro intento</button>` : ""}
                            </article>`;
                        }).join("")}</div>
                    </article>`).join("")}</div>
            </section>
            <footer class="admin-footer"><span>Los cambios se sincronizan con los grupos automáticamente.</span><button class="text-button" id="reset-button-bottom">Reiniciar todas las pistas y el reloj</button></footer>
        </div>
        <div id="toast" class="toast" role="status" aria-live="polite"></div>`;

    document.querySelector("#logout-button").addEventListener("click", async () => {
        try {
            await api("logout", {});
            renderLogin();
        } catch (error) { notify(error.message, "error"); }
    });
    document.querySelector("#save-setup").addEventListener("click", saveSetup);
    document.querySelector("#duration-save").addEventListener("click", async () => {
        const minutes = Number(document.querySelector("#timer-duration").value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
            notify("Elige una duración entre 1 y 60 minutos.", "error");
            return;
        }
        try {
            await api("timer", { operation: "set", duration_seconds: minutes * 60 });
            notify("Duración actualizada.");
            await loadAdmin();
        } catch (error) { notify(error.message, "error"); }
    });
    document.querySelector("#timer-toggle").addEventListener("click", async () => {
        try {
            await api("timer", { operation: timer.is_running ? "pause" : "start" });
            await loadAdmin();
        } catch (error) { notify(error.message, "error"); }
    });
    document.querySelector("#timer-reset").addEventListener("click", () => timerAction("reset"));
    document.querySelectorAll("#reset-button, #reset-button-bottom").forEach((button) => button.addEventListener("click", resetProgress));
    document.querySelector("#focus-save").addEventListener("click", async () => {
        try {
            await api("focus", {
                team_slug: document.querySelector("#focus-team").value,
                station_id: Number(document.querySelector("#focus-station").value),
            });
            notify("Estación activa actualizada.");
            await loadAdmin();
        } catch (error) { notify(error.message, "error"); }
    });
    document.querySelectorAll("[data-release]").forEach((button) => button.addEventListener("click", async () => {
        try {
            await api("release_hint", { team_slug: button.dataset.release, station_id: Number(button.dataset.station) });
            notify("Pista liberada para el grupo.");
            await loadAdmin();
        } catch (error) { notify(error.message, "error"); }
    }));
    document.querySelectorAll("[data-access]").forEach((button) => button.addEventListener("click", async () => {
        try {
            await api("set_hint_access", {
                team_slug: button.dataset.access,
                station_id: Number(button.dataset.station),
                enabled: button.dataset.enabled !== "true",
            });
            await loadAdmin();
        } catch (error) { notify(error.message, "error"); }
    }));
    document.querySelectorAll("[data-clear-request]").forEach((button) => button.addEventListener("click", async () => {
        try {
            await api("clear_hint_request", {
                team_slug: button.dataset.clearRequest,
                station_id: Number(button.dataset.station),
            });
            await loadAdmin();
        } catch (error) { notify(error.message, "error"); }
    }));
    document.querySelectorAll("input, textarea, select").forEach((input) => {
        input.addEventListener("input", () => { setupDirty = true; });
        input.addEventListener("change", () => { setupDirty = true; });
    });
}

function renderTeamSetup(team, stations) {
    return `<article class="team-setup-card" style="--team-color:${escapeHtml(team.color)}">
        <div class="team-setup-heading"><span class="team-dot"></span><h3>${escapeHtml(team.name)}</h3><span class="team-tag">${escapeHtml(team.slug)}</span></div>
        <label>Tema de investigación<textarea class="team-topic" data-team="${escapeHtml(team.slug)}" rows="3" placeholder="Escribe el tema asignado a este grupo...">${escapeHtml(team.topic)}</textarea></label>
        <div class="hint-fields"><div class="hint-fields-title">Pistas específicas de este tema</div>
            ${stations.map((station) => `<label>${escapeHtml(station.name)}<textarea class="hint-content" data-team="${escapeHtml(team.slug)}" data-station="${station.id}" rows="2" placeholder="Una pista que les oriente sin resolverles la sección...">${escapeHtml(team.hints?.[station.id]?.content || "")}</textarea></label>`).join("")}
        </div>
    </article>`;
}

async function saveSetup() {
    const teams = currentAdminState.teams.map((team) => ({
        slug: team.slug,
        topic: document.querySelector(`.team-topic[data-team="${team.slug}"]`).value,
    }));
    const stations = currentAdminState.stations.map((station) => ({
        id: station.id,
        name: document.querySelector(`.station-name[data-id="${station.id}"]`).value,
        format: document.querySelector(`.station-format[data-id="${station.id}"]`).value,
        facilitator_question: document.querySelector(`.station-question[data-id="${station.id}"]`).value,
        question: document.querySelector(`.quiz-question[data-id="${station.id}"]`).value,
        options: [0, 1, 2, 3].map((index) => document.querySelector(`.quiz-option[data-id="${station.id}"][data-option="${index}"]`).value),
        correct_option: document.querySelector(`.quiz-correct[data-id="${station.id}"]`).value === ""
            ? null
            : Number(document.querySelector(`.quiz-correct[data-id="${station.id}"]`).value),
    }));
    if (stations.some((station) => !station.question.trim() || station.options.some((option) => !option.trim()) || !Number.isInteger(station.correct_option))) {
        notify("Completa la pregunta, las cuatro opciones y la respuesta correcta de cada estación.", "error");
        return;
    }
    const hints = [...document.querySelectorAll(".hint-content")].map((input) => ({
        team_slug: input.dataset.team,
        station_id: Number(input.dataset.station),
        content: input.value,
    }));
    try {
        await api("save_setup", { teams, stations, hints });
        setupDirty = false;
        notify("Preparación guardada.");
        await loadAdmin();
    } catch (error) { notify(error.message, "error"); }
}

async function timerAction(operation) {
    try {
        await api("timer", { operation });
        await loadAdmin();
    } catch (error) { notify(error.message, "error"); }
}

async function resetProgress() {
    if (!window.confirm("Se volverán a ocultar todas las pistas y el temporizador regresará a su duración inicial. ¿Continuar?")) return;
    try {
        await api("reset_progress", {});
        setupDirty = false;
        notify("Dinámica reiniciada.");
        await loadAdmin();
    } catch (error) { notify(error.message, "error"); }
}

async function loadAdmin() {
    const state = await api("state");
    renderAdmin(state);
}

async function startAdmin() {
    try {
        const status = await api("admin_status");
        if (!status.is_admin) {
            renderLogin();
            return;
        }
        await loadAdmin();
        pollHandle = window.setInterval(async () => {
            try {
                const state = await api("state");
                if (!setupDirty && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
                    renderAdmin(state);
                } else {
                    syncClock(state.timer);
                }
            } catch (error) {
                if (error.message.includes("Inicia sesión")) renderLogin();
            }
        }, 2000);
    } catch (error) {
        app.innerHTML = `<section class="error-screen"><h1>No pudimos conectar</h1><p>${escapeHtml(error.message)}</p><a class="button button-dark" href="./">Volver al inicio</a></section>`;
    }
}

function renderTeamShell(team, stations) {
    app.innerHTML = `
        <div class="team-page" style="--team-color:${escapeHtml(team.color)}">
            <header class="topbar team-topbar">
                <a class="brand" href="./"><span class="brand-mark">✳</span> Reto de investigación</a>
                <span class="role-pill team-role-pill"><span class="team-dot"></span>${escapeHtml(team.name)}</span>
            </header>
            <section class="team-hero">
                <a class="back-link" href="./">← Cambiar de vista</a>
                <div class="eyebrow">SU RETO DE INVESTIGACIÓN</div>
                <h1>${escapeHtml(team.name)}<span class="team-period">.</span></h1>
                <article class="topic-card"><span class="section-kicker">TEMA ASIGNADO</span><p id="team-topic">${escapeHtml(team.topic || "Su tema todavía no ha sido asignado. Consulten con el equipo amarillo.")}</p></article>
            </section>
            <section class="team-progress">
                <div><div class="section-kicker">ESTACIONES</div><h2>Construyan su investigación</h2><p>Las pistas aparecerán aquí cuando el equipo amarillo las libere.</p></div>
                <aside class="team-clock"><span>TIEMPO DE LA RONDA</span><strong id="team-timer">--:--</strong><small id="team-timer-state">Esperando al equipo amarillo</small></aside>
            </section>
            <section class="station-grid">${stations.map((station) => `
                <article class="team-station ${station.is_unlocked ? "is-unlocked" : ""}" data-station="${station.id}">
                    <div class="station-topline"><span class="station-number">${String(station.sort_order).padStart(2, "0")}</span><span class="station-status">${station.is_unlocked ? "PISTA DESBLOQUEADA" : "PENDIENTE"}</span></div>
                    <h3>${escapeHtml(station.name)}</h3><p class="station-format">${escapeHtml(station.format)}</p>
                    <div class="question-box"></div>
                    <button class="button button-dark request-hint-button" data-request="${station.id}" disabled></button>
                    <div class="hint-box"></div>
                </article>`).join("")}</section>
            <footer class="team-footer">Piensen en equipo. Cada pista es una ayuda para que encuentren su propio camino.</footer>
        </div>`;
    app.insertAdjacentHTML("beforeend", '<div id="toast" class="toast" role="status" aria-live="polite"></div>');
    document.querySelectorAll("[data-request]").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
            await api("request_hint", { team_slug: color, station_id: Number(button.dataset.request) });
            notify("Solicitud enviada. Esperen a que el equipo amarillo revise su respuesta.");
            const state = await api("state", null, { color });
            updateTeamView(state);
        } catch (error) {
            button.disabled = false;
            notify(error.message, "error");
        }
    }));
}

function updateTeamView(state) {
    syncClock(state.timer);
    const topic = document.querySelector("#team-topic");
    if (topic) topic.textContent = state.team.topic || "Su tema todavía no ha sido asignado. Consulten con el equipo amarillo.";
    state.stations.forEach((station) => {
        const card = document.querySelector(`.team-station[data-station="${station.id}"]`);
        if (!card) return;
        card.querySelector("h3").textContent = station.name;
        card.querySelector(".station-format").textContent = station.format;
        const unlocked = station.is_unlocked && station.hint;
        const questionBox = card.querySelector(".question-box");
        questionBox.innerHTML = station.hint_enabled
            ? `<span class="hint-label">PREGUNTA DE LA ESTACIÓN</span><p>${escapeHtml(station.question)}</p><ol type="A">${station.options.map((option) => `<li>${escapeHtml(option)}</li>`).join("")}</ol>`
            : `<span class="locked-icon">⌁</span><p>El equipo amarillo todavía no ha habilitado esta pregunta.</p>`;
        card.classList.toggle("is-unlocked", Boolean(unlocked));
        card.querySelector(".station-status").textContent = unlocked ? "PISTA DESBLOQUEADA" : station.hint_requested ? "SOLICITUD ENVIADA" : station.hint_enabled ? "PREGUNTA DISPONIBLE" : "PENDIENTE";
        const requestButton = card.querySelector(".request-hint-button");
        requestButton.disabled = !station.hint_enabled || station.hint_requested || Boolean(unlocked);
        requestButton.textContent = unlocked
            ? "Pista liberada"
            : station.hint_requested
                ? "Solicitud enviada"
                : station.hint_enabled
                    ? "Ya respondimos, solicitar pista"
                    : "Pregunta aún no habilitada";
        card.querySelector(".hint-box").innerHTML = unlocked
            ? `<span class="hint-label">✦ SU PISTA</span><p>${escapeHtml(station.hint)}</p>`
            : `<span class="locked-icon">⌁</span><p>${station.hint_requested ? "El equipo amarillo revisará su respuesta." : "Respondan en voz alta. Después, soliciten la pista para que amarillo revise."}</p>`;
    });
}

async function startTeam() {
    try {
        const initial = await api("state", null, { color });
        renderTeamShell(initial.team, initial.stations);
        updateTeamView(initial);
        pollHandle = window.setInterval(async () => {
            try {
                const state = await api("state", null, { color });
                updateTeamView(state);
            } catch (error) {
                notify(error.message, "error");
            }
        }, 2000);
    } catch (error) {
        app.innerHTML = `<section class="error-screen"><a class="back-link" href="./">← Inicio</a><h1>Grupo no disponible</h1><p>${escapeHtml(error.message)}</p></section>`;
    }
}

if (view === "amarillos") {
    startAdmin();
} else if (view === "grupo") {
    startTeam();
} else {
    renderLanding();
}

window.addEventListener("pagehide", () => {
    window.clearInterval(pollHandle);
    window.clearInterval(clockHandle);
});
