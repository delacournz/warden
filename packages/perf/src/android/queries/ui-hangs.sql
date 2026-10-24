-- Frames the app finished past their deadline (frame timeline), worst first.
SELECT
  a.ts - (SELECT start_ts FROM trace_bounds) AS at_ns,
  a.dur AS dur_ns,
  a.jank_type AS jank_type,
  COALESCE(a.layer_name, '') AS layer,
  (SELECT COUNT(*) FROM actual_frame_timeline_slice a2 JOIN process p2 ON a2.upid = p2.upid
     WHERE p2.name = '{{PACKAGE}}') AS total_frames
FROM actual_frame_timeline_slice a
JOIN process p ON a.upid = p.upid
WHERE p.name = '{{PACKAGE}}'
  AND a.jank_type LIKE '%App Deadline Missed%'
ORDER BY a.dur DESC
LIMIT 100;
