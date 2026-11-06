-- Application pipeline: one row per job the user is tracking.
create table if not exists public.applications (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  company            text not null default '',
  role               text not null default '',
  status             text not null default 'saved'
                       check (status in ('saved','applied','interviewing','offer','closed')),
  close_reason       text check (close_reason in ('rejected','no_response','withdrew')),
  position           double precision not null default 0,
  job_url            text not null default '',
  job_description    text not null default '',
  original_resume    text not null default '',
  tailored_resume    text not null default '',
  cover_letter       text not null default '',
  fit_score          integer,              -- evidence-based fit (headline score)
  match_score_before integer,              -- ATS keyword match, original resume
  match_score_after  integer,              -- ATS keyword match, tailored resume
  analysis           jsonb not null default '{}'::jsonb,
  changes            jsonb not null default '[]'::jsonb,
  notes              text not null default '',
  next_step          text not null default '',
  next_step_date     date,
  activity           jsonb not null default '[]'::jsonb,
  truth_check        jsonb,
  followup           jsonb,
  interview_prep     jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists applications_user_status_idx
  on public.applications (user_id, status, position);

alter table public.applications enable row level security;

create policy "applications_select_own" on public.applications
  for select using ((select auth.uid()) = user_id);
create policy "applications_insert_own" on public.applications
  for insert with check ((select auth.uid()) = user_id);
create policy "applications_update_own" on public.applications
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "applications_delete_own" on public.applications
  for delete using ((select auth.uid()) = user_id);

create or replace function public.applications_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists applications_touch_updated_at on public.applications;
create trigger applications_touch_updated_at
  before update on public.applications
  for each row execute function public.applications_touch_updated_at();
