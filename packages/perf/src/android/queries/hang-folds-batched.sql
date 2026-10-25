-- ONE query for every hang: how the app's main thread spent each missed frame (state buckets in ns), plus GC overlap.
WITH app AS (
  SELECT upid, pid FROM process WHERE name = '{{PACKAGE}}'
),
main_thread AS (
  SELECT t.utid FROM thread t JOIN app ON t.upid = app.upid AND t.tid = app.pid
),
hangs AS (
  SELECT a.id AS hang_id, a.ts AS ts, a.dur AS dur
  FROM actual_frame_timeline_slice a
  JOIN app ON a.upid = app.upid
  WHERE a.jank_type LIKE '%App Deadline Missed%'
  ORDER BY a.dur DESC
  LIMIT 100
),
states AS (
  SELECT
    h.hang_id AS hang_id,
    CASE
      WHEN s.state = 'Running' THEN 'running'
      WHEN s.state IN ('R', 'R+') THEN 'runnable'
      WHEN s.state IN ('D', 'DK') THEN 'io'
      WHEN s.state IN ('S', 'I') THEN 'sleeping'
      ELSE 'other'
    END AS bucket,
    MIN(s.ts + s.dur, h.ts + h.dur) - MAX(s.ts, h.ts) AS overlap_ns
  FROM hangs h
  JOIN main_thread mt
  JOIN thread_state s ON s.utid = mt.utid AND s.ts < h.ts + h.dur AND s.ts + s.dur > h.ts
),
gc AS (
  SELECT
    h.hang_id AS hang_id,
    'gc' AS bucket,
    MIN(sl.ts + sl.dur, h.ts + h.dur) - MAX(sl.ts, h.ts) AS overlap_ns
  FROM hangs h
  JOIN slice sl ON sl.ts < h.ts + h.dur AND sl.ts + sl.dur > h.ts
  JOIN thread_track tt ON sl.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN app ON t.upid = app.upid
  WHERE sl.name LIKE '%GC%' AND sl.name NOT LIKE '%Trace%'
)
SELECT
  h.hang_id AS hang_id,
  h.ts - (SELECT start_ts FROM trace_bounds) AS at_ns,
  h.dur AS dur_ns,
  u.bucket AS bucket,
  SUM(u.overlap_ns) AS ns
FROM hangs h
JOIN (SELECT * FROM states UNION ALL SELECT * FROM gc) u ON u.hang_id = h.hang_id
GROUP BY h.hang_id, u.bucket
ORDER BY h.dur DESC, h.hang_id;
