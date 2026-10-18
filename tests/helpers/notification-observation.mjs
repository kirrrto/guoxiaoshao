// Sending/credit tests start with a task that has already passed event planning.
// Give that fixture the two known observations required by the production sender.
// Freshness integration tests use real recordObservation transitions instead.
export async function seedNotificationObservation(repo, task) {
  const knownAt = new Date(Date.parse(task.detectedAt) + 1).toISOString();
  await repo.saveLatest({ _id: `${task.storeNumber}|${task.partNumber}`, storeNumber: task.storeNumber, partNumber: task.partNumber,
    status: task.eventType === 'became_unavailable' ? 'unavailable' : 'available', statusSince: task.detectedAt,
    knownStreakSince: task.detectedAt, knownAt, observedAt: knownAt, unknownSince: null, statusConfirmed: true });
}
