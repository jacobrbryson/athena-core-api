const express = require('express');
const { requireAuthOrDevice } = require('../middleware/auth');
const { requireAdultActor } = require('../helpers/actor');
const workoutHistory = require('../services/workoutHistory');

// Recorded workout history (athena_workout) for the Health page. Reads only the
// signed-in adult's own rows; recording itself is gated in workoutHistory.
const router = express.Router();
router.use(requireAuthOrDevice);
router.get('/', async (req, res) => {
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 365, 3650));
    res.set('Cache-Control', 'no-store');
    res.json({ days, workouts: await workoutHistory.list(actor.profileId, { days, limit: 2000 }) });
  } catch (error) {
    console.error('[workouts] read failed:', error.message);
    res.status(503).json({ message: 'Workout history is temporarily unavailable' });
  }
});
module.exports = router;
