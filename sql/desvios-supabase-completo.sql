-- ============================================================
-- SISTEMA DE DESVÍOS OPERATIVOS — UPTU / División Transporte
-- ESQUEMA COMPLETO (reemplaza a los seis scripts anteriores)
--
-- Ejecutar en: Supabase → SQL Editor → New query → Run
-- Se puede correr las veces que haga falta: no borra datos ni
-- duplica nada. Sirve tanto para empezar de cero como para
-- poner al día una base que ya tiene desvíos cargados.
-- ============================================================


-- ------------------------------------------------------------
-- 1. QUIÉNES PUEDEN EDITAR
--    Solo los correos de esta tabla pueden crear o modificar
--    desvíos. El resto del mundo únicamente puede leer.
-- ------------------------------------------------------------
create table if not exists public.editores (
  email      text primary key,
  nombre     text,
  rol        text not null default 'editor' check (rol in ('editor', 'admin')),
  alta       timestamptz not null default now()
);

comment on table public.editores is
  'Personas habilitadas para publicar desvíos. Agregar o quitar filas aquí es lo único que cambia los permisos.';


-- ------------------------------------------------------------
-- 2. CASILLAS QUE RECIBEN LA COMUNICACIÓN
-- ------------------------------------------------------------
create table if not exists public.destinatarios (
  email   text primary key,
  nombre  text,
  activo  boolean not null default true,
  alta    timestamptz not null default now()
);

comment on table public.destinatarios is
  'Casillas a las que se comunica cada desvío publicado.';


-- ------------------------------------------------------------
-- 3. LOS DESVÍOS
-- ------------------------------------------------------------
create table if not exists public.desvios (
  id                   uuid primary key default gen_random_uuid(),

  -- líneas afectadas
  linea                text not null,
  lineas               text[] not null default '{}',
  variantes            integer[] not null default '{}',
  sentido              text,

  -- items del formulario de UPTU
  titulo               text not null,
  principal            text,
  entre                text,
  motivo               text,
  recorrido_texto      text,
  observaciones        text,

  -- vigencia
  estado               text not null default 'borrador'
                       check (estado in ('borrador', 'activo', 'finalizado')),
  desde                timestamptz,
  hasta                timestamptz,

  -- el desvío sobre el mapa
  recorrido            jsonb not null default '[]'::jsonb,
  paradas_suspendidas  integer[] not null default '{}',
  paradas_provisorias  jsonb not null default '[]'::jsonb,
  resumen              jsonb not null default '{}'::jsonb,

  -- trazabilidad
  creado_por           text,
  creado_en            timestamptz not null default now(),
  actualizado_por      text,
  actualizado_en       timestamptz not null default now()
);

-- columnas que se agregaron después (por si la tabla ya existía)
alter table public.desvios add column if not exists lineas          text[] not null default '{}';
alter table public.desvios add column if not exists principal       text;
alter table public.desvios add column if not exists entre           text;
alter table public.desvios add column if not exists recorrido_texto text;
alter table public.desvios add column if not exists resumen         jsonb not null default '{}'::jsonb;

create index if not exists desvios_estado_idx   on public.desvios (estado);
create index if not exists desvios_linea_idx    on public.desvios (linea);
create index if not exists desvios_vigencia_idx on public.desvios (desde, hasta);

comment on table public.desvios is
  'Desvíos operativos. Los de estado=activo son los que ve el personal en calle.';
comment on column public.desvios.resumen is
  'Datos ya resueltos para el visor: recorridos, calles del trazado y nombre + coordenadas de cada parada suspendida.';


-- ------------------------------------------------------------
-- 4. HISTORIAL
-- ------------------------------------------------------------
create table if not exists public.desvios_historial (
  id           bigserial primary key,
  desvio_id    uuid not null,
  accion       text not null,
  quien        text,
  cuando       timestamptz not null default now(),
  datos_antes  jsonb
);

create index if not exists desvios_hist_idx on public.desvios_historial (desvio_id, cuando desc);


-- ------------------------------------------------------------
-- 5. AUTORIZACIÓN
-- ------------------------------------------------------------
create or replace function public.es_editor()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.editores e
    where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;


-- ------------------------------------------------------------
-- 6. SELLO DE MODIFICACIÓN + HISTORIAL
-- ------------------------------------------------------------
create or replace function public.desvios_sellar()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.creado_por      := coalesce(auth.jwt() ->> 'email', 'desconocido');
    new.actualizado_por := new.creado_por;
    new.actualizado_en  := now();
    insert into public.desvios_historial (desvio_id, accion, quien)
      values (new.id, 'alta', new.creado_por);
    return new;
  elsif (tg_op = 'UPDATE') then
    new.actualizado_por := coalesce(auth.jwt() ->> 'email', 'desconocido');
    new.actualizado_en  := now();
    insert into public.desvios_historial (desvio_id, accion, quien, datos_antes)
      values (new.id, 'modificacion', new.actualizado_por, to_jsonb(old));
    return new;
  else
    insert into public.desvios_historial (desvio_id, accion, quien, datos_antes)
      values (old.id, 'baja', coalesce(auth.jwt() ->> 'email', 'desconocido'), to_jsonb(old));
    return old;
  end if;
end;
$$;

drop trigger if exists desvios_sellar_trg on public.desvios;
create trigger desvios_sellar_trg
  before insert or update or delete on public.desvios
  for each row execute function public.desvios_sellar();


-- ------------------------------------------------------------
-- 7. PERMISOS (Row Level Security)
--    La autorización no depende del programa: la base misma
--    rechaza lo que no corresponde.
-- ------------------------------------------------------------
alter table public.desvios           enable row level security;
alter table public.editores          enable row level security;
alter table public.destinatarios     enable row level security;
alter table public.desvios_historial enable row level security;

-- Sitio privado: para ver los desvíos hay que tener sesión iniciada.
-- (Si alguna vez se quisiera abrir al público, cambiar "to authenticated"
--  por "to anon, authenticated" en esta politica.)
drop policy if exists "lectura publica de activos" on public.desvios;
drop policy if exists "lectura de activos con sesion" on public.desvios;
create policy "lectura de activos con sesion"
  on public.desvios for select to authenticated using (estado = 'activo');

drop policy if exists "editores ven todo" on public.desvios;
create policy "editores ven todo"
  on public.desvios for select to authenticated using (public.es_editor());

drop policy if exists "editores crean" on public.desvios;
create policy "editores crean"
  on public.desvios for insert to authenticated with check (public.es_editor());

drop policy if exists "editores modifican" on public.desvios;
create policy "editores modifican"
  on public.desvios for update to authenticated
  using (public.es_editor()) with check (public.es_editor());

drop policy if exists "editores eliminan" on public.desvios;
create policy "editores eliminan"
  on public.desvios for delete to authenticated using (public.es_editor());

drop policy if exists "consulta de habilitacion" on public.editores;
create policy "consulta de habilitacion"
  on public.editores for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email') or public.es_editor());

drop policy if exists "editores ven destinatarios" on public.destinatarios;
create policy "editores ven destinatarios"
  on public.destinatarios for select to authenticated using (public.es_editor());

drop policy if exists "editores administran destinatarios" on public.destinatarios;
create policy "editores administran destinatarios"
  on public.destinatarios for all to authenticated
  using (public.es_editor()) with check (public.es_editor());

drop policy if exists "editores ven historial" on public.desvios_historial;
create policy "editores ven historial"
  on public.desvios_historial for select to authenticated using (public.es_editor());


-- ------------------------------------------------------------
-- 8. HABILITAR A LA GENTE
--    Hay dos niveles:
--      * Solo consultar  -> alcanza con crear el usuario en
--        Authentication -> Users (no va en la tabla editores).
--      * Editar          -> ademas de ese usuario, agregar su
--        correo a la tabla editores (abajo).
--    Cambiar por los correos reales. Ojo: además de esta fila,
--    cada persona necesita usuario en Authentication → Users.
-- ------------------------------------------------------------
insert into public.editores (email, nombre, rol) values
  ('agustin.guarch@imm.gub.uy', 'Agus', 'admin')
on conflict (email) do update set rol = excluded.rol;

-- insert into public.editores (email, nombre, rol) values
--   ('companero@imm.gub.uy', 'Nombre Apellido', 'editor');

-- insert into public.destinatarios (email, nombre) values
--   ('inspectores.uptu@imm.gub.uy', 'Inspección UPTU'),
--   ('operaciones@empresa.com.uy',  'Empresa operaciones');


-- que la API se entere de los cambios de estructura
notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- 9. COMPROBACIONES
-- ------------------------------------------------------------
-- ¿Quiénes pueden editar?
--   select * from public.editores order by alta;

-- ¿A quiénes se les comunica?
--   select * from public.destinatarios where activo order by email;

-- ¿Qué desvíos están activos?
--   select linea, titulo, desde, hasta, actualizado_por, actualizado_en
--     from public.desvios where estado = 'activo' order by actualizado_en desc;

-- ¿Quién tocó qué?
--   select h.cuando, h.quien, h.accion, d.linea, d.titulo
--     from public.desvios_historial h
--     left join public.desvios d on d.id = h.desvio_id
--    order by h.cuando desc limit 50;
