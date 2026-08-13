-- #390: our own copy of the OC probability model.
--
-- tornprobability.com:3000 is one person's server on a non-standard port with
-- no SLA, and a dataset still being filled in. The simulator computes against
-- THIS copy, never the live service: an outage then degrades to stale numbers
-- instead of a dead page, and the CORS problem disappears with the browser
-- call.
--
-- ⚠️ The port is HTTPS, not HTTP. The ticket recorded `http://…:3000`; a plain
-- HTTP request to it gets an empty reply, which is the failure mode most likely
-- to be mistaken for the service being down.

-- One row per crime scenario.
CREATE TABLE IF NOT EXISTS public.oc_scenarios (
  name             text PRIMARY KEY,
  -- How many roles the crime takes. From GetSupportedScenarios.
  parameter_count  int  NOT NULL,
  -- ⚠️ Completeness exists ONLY on the /scenarios HTML page — the API does not
  -- carry it, and an in-progress scenario answers with numbers that look
  -- exactly as authoritative as a finished one (Lock Stock, mapped from 126
  -- observed paths, returns endings summing to 1.00000 just like Break the
  -- Bank's 911). NULL means we have not read the page, which is distinct from
  -- false. A simulator stating a number with false confidence is #376 again.
  is_complete      boolean,
  observed_paths   int,
  -- The mermaid flowchart, as fetched from the SSE diagram feed. Parsed by
  -- server/src/oc/scenarioTree.ts.
  diagram          text,
  -- Result of validateScenarioTree() at mirror time. A diagram that fails its
  -- own invariants must not silently back a simulator.
  diagram_valid    boolean,
  diagram_problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Roles per scenario, in position order.
--
-- ⚠️ The name-join hazard, confirmed against the live service on 2026-08-13:
-- GetRoleNames keys scenarios as "Mob Mentality" and roles as "Looter 1",
-- while GetRoleWeights keys the SAME scenario as "MobMentality" and the same
-- role as "Looter1". Joining them raw silently drops every multi-word name —
-- which is most of them — and a missing weight looks identical to a role that
-- genuinely has none. The mirror normalises both sides and records the weight
-- as NULL only when the join truly found nothing.
CREATE TABLE IF NOT EXISTS public.oc_scenario_roles (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  -- "P1".."P6" — the position index CalculateSuccess expects its CPR vector in.
  position_id   text NOT NULL,
  role_name     text NOT NULL,
  weight        numeric,
  PRIMARY KEY (scenario_name, position_id)
);

-- goodEndingN / badEndingN → the diagram node it actually corresponds to.
--
-- ⚠️ Nothing in either API response states this correspondence, and position
-- matching is not merely unproven but WRONG: for Break the Bank the derived
-- mapping swaps positions 3 and 4 against declaration order, so two endings
-- would carry each other's payouts. Derived by server/src/oc/endingMap.ts from
-- two independent signals that must agree.
--
-- `resolved` is false when the derivation refused — no baseline probe, an
-- ending-count mismatch, or a tie it cannot break (Muscle 3 and Thief 2 gate
-- the same checkpoint in Break the Bank and are indistinguishable under
-- single-role probes). An unresolved ending keeps its row so the reason is
-- visible; it just has no node id.
CREATE TABLE IF NOT EXISTS public.oc_scenario_endings (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  ending_key    text NOT NULL,          -- 'goodEnding3'
  node_id       text,                   -- '_A9S_', or NULL when unresolved
  kind          text NOT NULL,          -- 'good' | 'bad'
  resolved      boolean NOT NULL DEFAULT false,
  problem       text,
  PRIMARY KEY (scenario_name, ending_key)
);

CREATE INDEX IF NOT EXISTS oc_scenario_endings_node_idx
  ON public.oc_scenario_endings (scenario_name, node_id);
