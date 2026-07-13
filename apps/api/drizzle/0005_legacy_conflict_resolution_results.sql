UPDATE `conflicts`
SET `resolution_result` = json_object(
  'legacy', json('true'),
  'resolution', `resolution`,
  'affectedVersions', json('{}')
)
WHERE `status` = 'resolved'
  AND `resolution_result` IS NULL;
