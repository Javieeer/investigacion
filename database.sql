CREATE TABLE IF NOT EXISTS public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.teams (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color CHAR(7) NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    sort_order SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.stations (
    id SMALLINT PRIMARY KEY,
    name TEXT NOT NULL,
    format TEXT NOT NULL,
    facilitator_question TEXT NOT NULL,
    sort_order SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.station_questions (
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    question TEXT NOT NULL DEFAULT '',
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (team_slug, station_id)
);

CREATE TABLE IF NOT EXISTS public.station_answers (
    station_id SMALLINT PRIMARY KEY REFERENCES public.stations (id) ON DELETE CASCADE,
    correct_option SMALLINT CHECK (correct_option BETWEEN 0 AND 3)
);

CREATE TABLE IF NOT EXISTS public.hints (
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (team_slug, station_id)
);

CREATE TABLE IF NOT EXISTS public.hint_access (
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (team_slug, station_id)
);

CREATE TABLE IF NOT EXISTS public.hint_requests (
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    requested BOOLEAN NOT NULL DEFAULT FALSE,
    requested_at TIMESTAMPTZ,
    PRIMARY KEY (team_slug, station_id)
);

CREATE TABLE IF NOT EXISTS public.hint_releases (
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    is_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    unlocked_at TIMESTAMPTZ,
    PRIMARY KEY (team_slug, station_id)
);

CREATE TABLE IF NOT EXISTS public.dynamics (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    duration_seconds INTEGER NOT NULL DEFAULT 300,
    remaining_seconds INTEGER NOT NULL DEFAULT 300,
    ends_at TIMESTAMPTZ,
    is_running BOOLEAN NOT NULL DEFAULT FALSE,
    active_team TEXT REFERENCES public.teams (slug) ON DELETE SET NULL,
    active_station SMALLINT REFERENCES public.stations (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.station_timers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 60 AND 3600),
    remaining_seconds INTEGER NOT NULL CHECK (remaining_seconds BETWEEN 0 AND 3600),
    ends_at TIMESTAMPTZ,
    is_running BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_slug, station_id)
);

CREATE TABLE IF NOT EXISTS public.station_timer_status (
    id UUID PRIMARY KEY REFERENCES public.station_timers (id) ON DELETE CASCADE,
    team_slug TEXT NOT NULL REFERENCES public.teams (slug) ON DELETE CASCADE,
    station_id SMALLINT NOT NULL REFERENCES public.stations (id) ON DELETE CASCADE,
    duration_seconds INTEGER NOT NULL,
    remaining_seconds INTEGER NOT NULL,
    ends_at TIMESTAMPTZ,
    is_running BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.sync_station_timer_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.station_timer_status WHERE id = OLD.id;
        RETURN OLD;
    END IF;

    INSERT INTO public.station_timer_status (
        id, team_slug, station_id, duration_seconds, remaining_seconds, ends_at, is_running, created_at
    ) VALUES (
        NEW.id, NEW.team_slug, NEW.station_id, NEW.duration_seconds, NEW.remaining_seconds,
        NEW.ends_at, NEW.is_running, NEW.created_at
    )
    ON CONFLICT (id) DO UPDATE SET
        team_slug = EXCLUDED.team_slug,
        station_id = EXCLUDED.station_id,
        duration_seconds = EXCLUDED.duration_seconds,
        remaining_seconds = EXCLUDED.remaining_seconds,
        ends_at = EXCLUDED.ends_at,
        is_running = EXCLUDED.is_running,
        created_at = EXCLUDED.created_at;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_station_timer_status ON public.station_timers;
CREATE TRIGGER sync_station_timer_status
    AFTER INSERT OR UPDATE OR DELETE ON public.station_timers
    FOR EACH ROW EXECUTE FUNCTION public.sync_station_timer_status();

CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE SQL
STABLE
AS $$
    SELECT NOW();
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_users
        WHERE user_id = (SELECT auth.uid())
    );
$$;

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hint_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hint_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hint_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dynamics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_timer_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read their own admin record" ON public.admin_users;
CREATE POLICY "Admins can read their own admin record"
    ON public.admin_users FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Anyone can read teams" ON public.teams;
CREATE POLICY "Anyone can read teams"
    ON public.teams FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can update teams" ON public.teams;
CREATE POLICY "Admins can update teams"
    ON public.teams FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read stations" ON public.stations;
CREATE POLICY "Anyone can read stations"
    ON public.stations FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can update stations" ON public.stations;
CREATE POLICY "Admins can update stations"
    ON public.stations FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read station questions" ON public.station_questions;
CREATE POLICY "Anyone can read station questions"
    ON public.station_questions FOR SELECT TO anon, authenticated
    USING (
        (SELECT public.is_admin())
        OR EXISTS (
            SELECT 1 FROM public.hint_access AS a
            WHERE a.team_slug = station_questions.team_slug
              AND a.station_id = station_questions.station_id
              AND a.enabled
        )
    );
DROP POLICY IF EXISTS "Admins can update station questions" ON public.station_questions;
CREATE POLICY "Admins can update station questions"
    ON public.station_questions FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Admins can read station answers" ON public.station_answers;
CREATE POLICY "Admins can read station answers"
    ON public.station_answers FOR SELECT TO authenticated
    USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS "Admins can update station answers" ON public.station_answers;
CREATE POLICY "Admins can update station answers"
    ON public.station_answers FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Admins and released hints can be read" ON public.hints;
CREATE POLICY "Admins and released hints can be read"
    ON public.hints FOR SELECT TO anon, authenticated
    USING (
        (SELECT public.is_admin())
        OR EXISTS (
            SELECT 1 FROM public.hint_releases AS r
            WHERE r.team_slug = hints.team_slug
              AND r.station_id = hints.station_id
              AND r.is_unlocked
        )
    );
DROP POLICY IF EXISTS "Admins can update hints" ON public.hints;
CREATE POLICY "Admins can update hints"
    ON public.hints FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read hint releases" ON public.hint_releases;
CREATE POLICY "Anyone can read hint releases"
    ON public.hint_releases FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can update hint releases" ON public.hint_releases;
CREATE POLICY "Admins can update hint releases"
    ON public.hint_releases FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read hint access" ON public.hint_access;
CREATE POLICY "Anyone can read hint access"
    ON public.hint_access FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can update hint access" ON public.hint_access;
CREATE POLICY "Admins can update hint access"
    ON public.hint_access FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read hint requests" ON public.hint_requests;
CREATE POLICY "Anyone can read hint requests"
    ON public.hint_requests FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS "Participants can request enabled hints" ON public.hint_requests;
CREATE POLICY "Participants can request enabled hints"
    ON public.hint_requests FOR UPDATE TO anon, authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.hint_access AS a
            WHERE a.team_slug = hint_requests.team_slug
              AND a.station_id = hint_requests.station_id
              AND a.enabled
        )
        AND EXISTS (
            SELECT 1 FROM public.hint_releases AS r
            WHERE r.team_slug = hint_requests.team_slug
              AND r.station_id = hint_requests.station_id
              AND NOT r.is_unlocked
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.hint_access AS a
            WHERE a.team_slug = hint_requests.team_slug
              AND a.station_id = hint_requests.station_id
              AND a.enabled
        )
    );
DROP POLICY IF EXISTS "Admins can update hint requests" ON public.hint_requests;
CREATE POLICY "Admins can update hint requests"
    ON public.hint_requests FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read dynamics" ON public.dynamics;
CREATE POLICY "Anyone can read dynamics"
    ON public.dynamics FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can update dynamics" ON public.dynamics;
CREATE POLICY "Admins can update dynamics"
    ON public.dynamics FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Admins can read station timers" ON public.station_timers;
CREATE POLICY "Admins can read station timers"
    ON public.station_timers FOR SELECT TO authenticated
    USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS "Admins can create their own station timers" ON public.station_timers;
CREATE POLICY "Admins can create their own station timers"
    ON public.station_timers FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.is_admin()) AND created_by = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Creators can update their station timers" ON public.station_timers;
CREATE POLICY "Creators can update their station timers"
    ON public.station_timers FOR UPDATE TO authenticated
    USING ((SELECT public.is_admin()) AND created_by = (SELECT auth.uid()))
    WITH CHECK ((SELECT public.is_admin()) AND created_by = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Creators can delete their station timers" ON public.station_timers;
CREATE POLICY "Creators can delete their station timers"
    ON public.station_timers FOR DELETE TO authenticated
    USING ((SELECT public.is_admin()) AND created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Anyone can read station timer status" ON public.station_timer_status;
CREATE POLICY "Anyone can read station timer status"
    ON public.station_timer_status FOR SELECT TO anon, authenticated USING (TRUE);

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_server_time() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_station_timer_status() FROM PUBLIC;

GRANT SELECT ON public.teams, public.stations, public.hint_releases, public.dynamics TO anon, authenticated;
GRANT SELECT ON public.station_timer_status TO anon, authenticated;
GRANT SELECT ON public.station_questions, public.hint_access, public.hint_requests TO anon, authenticated;
GRANT SELECT ON public.hints TO anon, authenticated;
GRANT SELECT ON public.admin_users TO authenticated;
GRANT UPDATE ON public.teams, public.stations, public.hints, public.hint_releases, public.dynamics TO authenticated;
GRANT UPDATE ON public.station_questions, public.station_answers, public.hint_access, public.hint_requests TO authenticated;
GRANT SELECT ON public.station_answers TO authenticated;
GRANT UPDATE (requested, requested_at) ON public.hint_requests TO anon;
GRANT SELECT, INSERT, DELETE ON public.station_timers TO authenticated;
GRANT UPDATE (remaining_seconds, ends_at, is_running) ON public.station_timers TO authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (
           SELECT 1 FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime'
             AND schemaname = 'public'
             AND tablename = 'station_timer_status'
       ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.station_timer_status;
    END IF;
END;
$$;

INSERT INTO public.teams (slug, name, color, topic, sort_order) VALUES
    ('salmones', 'Los salmones', '#df866f', '', 1),
    ('verdes', 'Los verdes', '#4b8b68', '', 2),
    ('azules', 'Los azules', '#5278a9', '', 3)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.stations (id, name, format, facilitator_question, sort_order) VALUES
    (1, 'Objetivos', 'Árbol o mapa de objetivos', '¿Qué quieren comprender o lograr con esta investigación?', 1),
    (2, 'Introducción', 'Nube de ideas', '¿Qué contexto necesita conocer alguien antes de leer el trabajo?', 2),
    (3, 'Justificación', 'Notas adhesivas', '¿Por qué vale la pena investigar este tema y a quién le sirve?', 3),
    (4, 'Marco teórico y referencial', 'Línea de tiempo, recortes y conceptos', '¿Qué conceptos, antecedentes y fuentes ayudan a explicar el tema?', 4),
    (5, 'Conclusiones', 'Globos de diálogo o frases finales', '¿Qué ideas responden a los objetivos y qué aprendieron?', 5)
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.stations WHERE id = 6;

INSERT INTO public.station_questions (team_slug, station_id, question, options)
SELECT teams.slug, question.station_id, question.question, question.options
FROM public.teams
CROSS JOIN (VALUES
    (1, '¿Cuál es la función principal del objetivo general de una investigación?', '["Expresar qué busca lograr o comprender el estudio","Enumerar todas las fuentes consultadas","Presentar los resultados finales","Describir únicamente el presupuesto"]'::jsonb),
    (2, '¿Qué debe lograr principalmente la introducción de una investigación?', '["Presentar el tema y el contexto necesario para comprenderlo","Repetir todas las conclusiones","Incluir únicamente la bibliografía","Describir cada respuesta de la encuesta"]'::jsonb),
    (3, '¿Qué responde principalmente la justificación de una investigación?', '["Por qué es importante el estudio y a quién puede beneficiar","Cuántas páginas tendrá el informe","Qué título tendrá cada capítulo","En qué orden se escribieron los párrafos"]'::jsonb),
    (4, '¿Qué aporta el marco teórico y referencial?', '["Conceptos, teorías y antecedentes que ayudan a explicar el tema","Una lista de opiniones sin fuentes","Solo los resultados obtenidos","El cronograma de entrega"]'::jsonb),
    (5, '¿En qué deben basarse las conclusiones?', '["En los hallazgos y su relación con los objetivos","En información nueva que no se investigó","En las preferencias personales del equipo","En copiar la introducción"]'::jsonb)
) AS question(station_id, question, options)
ON CONFLICT (team_slug, station_id) DO NOTHING;

INSERT INTO public.station_answers (station_id) VALUES
    (1), (2), (3), (4), (5)
ON CONFLICT (station_id) DO NOTHING;

INSERT INTO public.hints (team_slug, station_id)
SELECT teams.slug, stations.id FROM public.teams CROSS JOIN public.stations
ON CONFLICT (team_slug, station_id) DO NOTHING;

INSERT INTO public.hint_access (team_slug, station_id)
SELECT teams.slug, stations.id FROM public.teams CROSS JOIN public.stations
ON CONFLICT (team_slug, station_id) DO NOTHING;

INSERT INTO public.hint_requests (team_slug, station_id)
SELECT teams.slug, stations.id FROM public.teams CROSS JOIN public.stations
ON CONFLICT (team_slug, station_id) DO NOTHING;

INSERT INTO public.hint_releases (team_slug, station_id)
SELECT teams.slug, stations.id FROM public.teams CROSS JOIN public.stations
ON CONFLICT (team_slug, station_id) DO NOTHING;

INSERT INTO public.dynamics (id, duration_seconds, remaining_seconds)
VALUES (1, 300, 300)
ON CONFLICT (id) DO NOTHING;
