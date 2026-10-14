const express = require('express');
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/projects');

// Projects (docs/architecture/projects.md). Adult-only; every write answers with
// the whole snapshot. Concern and charter routes come before /:uuid so their
// names are never read as a project id.
const router = express.Router();
const json = express.json({ limit: '128kb' });
router.use(requireAuth);

router.get('/', c.list);
router.post('/', json, c.create);
router.get('/property', require('../controllers/properties').list);
router.get('/property/weather', require('../controllers/properties').weather);
router.put('/property', express.json({ limit: '4mb' }), require('../controllers/properties').save);

router.post('/concerns', json, c.createConcern);
router.patch('/concerns/:uuid', json, c.updateConcern);
router.delete('/concerns/:uuid', c.removeConcern);

router.put('/charters/:area', json, c.putCharter);
router.get('/binding-options', c.bindingOptions);

router.patch('/:uuid', json, c.update);
router.delete('/:uuid', c.remove);

router.post('/:uuid/steps', json, c.addStep);
router.post('/:uuid/steps/reorder', json, c.reorderSteps);
router.patch('/:uuid/steps/:stepUuid', json, c.updateStep);
router.delete('/:uuid/steps/:stepUuid', c.removeStep);

router.get('/:uuid/entries', c.listEntries);
// Photos arrive as base64 JSON (≤3 MB decoded). server.js gives this path an
// 8 MB parser before the global 100 kB one, the same as memory photos.
router.post('/:uuid/entries', express.json({ limit: '8mb' }), c.addEntry);
router.patch('/:uuid/entries/:entryUuid', json, c.updateEntry);
router.delete('/:uuid/entries/:entryUuid', c.removeEntry);
router.get('/:uuid/entries/:entryUuid/image', c.entryImage);

// Bindings: read data Athena already has (weight, WHOOP, calendar), live.
router.get('/:uuid/bound', c.bound);
router.post('/:uuid/bindings', json, c.addBinding);
router.delete('/:uuid/bindings/:bindingUuid', c.removeBinding);

router.post('/:uuid/links', json, c.addLink);
router.delete('/:uuid/links', c.removeLink);

module.exports = router;
