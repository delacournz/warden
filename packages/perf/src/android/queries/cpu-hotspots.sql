-- Self samples of the app's callstack sampler, per thread and leaf function.
SELECT
  COALESCE(t.name, 'tid ' || t.tid) AS thread,
  COALESCE(f.name, '[unknown]') AS function,
  COALESCE(m.name, '') AS dso,
  COUNT(*) AS samples
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p ON t.upid = p.upid
LEFT JOIN stack_profile_callsite c ON ps.callsite_id = c.id
LEFT JOIN stack_profile_frame f ON c.frame_id = f.id
LEFT JOIN stack_profile_mapping m ON f.mapping = m.id
WHERE p.name = '{{PACKAGE}}'
GROUP BY thread, function, dso
ORDER BY samples DESC
LIMIT 300;
