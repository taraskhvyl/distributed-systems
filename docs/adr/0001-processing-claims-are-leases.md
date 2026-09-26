---
status: accepted
---

# Processing claims are leases, recovered by a reaper

A processor claims a file by a compare-and-set to `processing`. A worker that dies mid-job
never releases that claim, and Kafka redelivery can't recover it: the redelivered event
fails the CAS, is skipped, and its offset is committed, so the file is stuck forever. We
treat the claim as a **120 s lease** (stamped in `updated_at`). Each processor runs a
reaper every 30 s that atomically resets expired claims to `uploaded` and re-enqueues the
work on the retry topic.

## Considered options

- **Rely on Kafka redelivery.** Rejected: the redelivery arrives while the claim still
  looks live, so it is skipped. That is the original bug.
- **Don't commit the offset on a failed claim; retry instead.** Rejected: the retry topic
  has no delay, so it spins and exhausts `max_attempts`, marking a healthy file `failed`.
- **Hold a DB row lock (`SELECT … FOR UPDATE`) for the whole job.** Rejected: it ties up a
  transaction and connection for the duration of S3 I/O, and needs one connection per
  in-flight job.
- **Separate `claimed_at` column.** Rejected for now: `updated_at` is already stamped at
  claim time and nothing else touches a `processing` row, so no schema change was needed.

## Consequences

- **A lease is not mutual exclusion.** A worker that is slow or partitioned (not dead)
  can finish after its lease was reaped, so the job runs twice. That's acceptable here
  because processing is deterministic (same thumbnail key, same checksum). Any future
  processing with external side effects needs **fencing tokens**. See ROADMAP Phase 3,
  "Network partition".
- The lease (120 s) must exceed the slowest legitimate job; tune
  `claim_lease_seconds` in `services/processor/src/config.py` if jobs get heavier.
- A file that crashes the worker every time is re-queued forever until an `attempts`
  counter routes it to the DLQ (ROADMAP Phase 3, "Poison pill").
- Recovery latency after a crash is up to lease + reap interval (~150 s).
