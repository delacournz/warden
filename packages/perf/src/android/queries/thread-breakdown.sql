-- Where each app thread's wall time went over the trace (scheduler states, ns).
SELECT
  COALESCE(t.name, 'tid ' || t.tid) AS thread,
  t.tid AS tid,
  SUM(CASE WHEN s.state = 'Running' THEN s.dur ELSE 0 END) AS running_ns,
  SUM(CASE WHEN s.state IN ('R', 'R+') THEN s.dur ELSE 0 END) AS runnable_ns,
  SUM(CASE WHEN s.state IN ('D', 'DK') THEN s.dur ELSE 0 END) AS io_ns,
  SUM(CASE WHEN s.state IN ('S', 'I') THEN s.dur ELSE 0 END) AS sleeping_ns
FROM thread_state s
JOIN thread t USING (utid)
JOIN process p ON t.upid = p.upid
WHERE p.name = '{{PACKAGE}}'
GROUP BY t.utid
ORDER BY running_ns DESC
LIMIT 25;
