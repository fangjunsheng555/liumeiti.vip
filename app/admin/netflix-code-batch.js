const DELETE_BATCH_SIZE = 40;

function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

export function toggleRecordSelection(current, recordId) {
  const selected = new Set(unique(current));
  if (selected.has(recordId)) selected.delete(recordId);
  else if (recordId) selected.add(recordId);
  return Array.from(selected);
}

export function toggleVisibleRecordSelection(current, visibleIds) {
  const selected = new Set(unique(current));
  const visible = unique(visibleIds);
  const allSelected = visible.length > 0 && visible.every((recordId) => selected.has(recordId));
  for (const recordId of visible) {
    if (allSelected) selected.delete(recordId);
    else selected.add(recordId);
  }
  return Array.from(selected);
}

export function selectedMailDeletionIds(events, selectedEventIds) {
  const selected = new Set(unique(selectedEventIds));
  return unique((Array.isArray(events) ? events : [])
    .filter((event) => selected.has(event?.eventId))
    .flatMap((event) => event?.eventIds?.length ? event.eventIds : [event?.eventId]));
}

export function recordDeleteBatches(recordIds) {
  const ids = unique(recordIds);
  const batches = [];
  for (let index = 0; index < ids.length; index += DELETE_BATCH_SIZE) {
    batches.push(ids.slice(index, index + DELETE_BATCH_SIZE));
  }
  return batches;
}
