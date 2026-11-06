-- Outcome dataset: anonymized, opt-in records of which resumes got interviews.
-- This is what lets Resumatch learn over time (and validate its own Fit score).
--
-- Privacy model:
--   * Opt-in only (profiles.share_outcomes). Nothing is written without it.
--   * No user id, email or name is stored. `contributor` is an HMAC of the user id with a
--     server secret: not reversible, but lets a user delete everything they contributed.
--   * `sample_key` is an HMAC of the application id, so a later outcome update (e.g. a
--     rejection that becomes an interview) updates the same row instead of duplicating it.
--   * Resume text is redacted (emails, phones, links, street addresses, the name line).
--   * RLS is on with no policies: only the API (service role) can read or write.

alter table public.profiles
  add column if not exists share_outcomes boolean not null default false;

create table if not exists public.outcome_samples (
  id               uuid primary key default gen_random_uuid(),
  sample_key       text not null unique,
  contributor      text not null,
  outcome          text not null check (outcome in ('interview', 'rejected', 'no_response')),
  reached_offer    boolean not null default false,
  fit_score        integer check (fit_score between 0 and 100),
  keyword_score    integer check (keyword_score between 0 and 100),
  role             text not null default '',
  company          text not null default '',
  jd_hash          text,
  job_description  text not null default '',
  requirements     jsonb not null default '[]'::jsonb,   -- [{skill, importance, level}] (no quotes)
  resume_version   text check (resume_version in ('tailored', 'original')),
  resume_redacted  text not null default '',
  days_to_outcome  integer,
  source           text not null default 'self_report' check (source in ('self_report', 'verified')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists outcome_samples_fit_idx on public.outcome_samples (fit_score);
create index if not exists outcome_samples_jd_idx on public.outcome_samples (jd_hash);
create index if not exists outcome_samples_contributor_idx on public.outcome_samples (contributor);

alter table public.outcome_samples enable row level security;
