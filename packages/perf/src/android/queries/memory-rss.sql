-- Resident set size of the app over time (process_stats poll), bytes.
SELECT
  c.ts - (SELECT start_ts FROM trace_bounds) AS t_ns,
  CAST(c.value AS INT) AS bytes
FROM counter c
JOIN process_counter_track pct ON c.track_id = pct.id
JOIN process p ON pct.upid = p.upid
WHERE p.name = '{{PACKAGE}}' AND pct.name = 'mem.rss'
ORDER BY c.ts;
