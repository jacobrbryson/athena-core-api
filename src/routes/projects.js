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
// Issue photos arrive as JPEG data URLs (up to four of 1.5 MB); server.js gives
// /projects/property an 8 MB parser before the global one.
const issues = require('../controllers/propertyIssues');
router.get('/property/issues', issues.list);
router.post('/property/issues', express.json({ limit: '8mb' }), issues.create);
router.patch('/property/issues/:uuid', express.json({ limit: '8mb' }), issues.update);
router.delete('/property/issues/:uuid', issues.remove);
router.get('/property/issues/:uuid/photos', issues.photos);
router.post('/property/issues/:uuid/notes', json, issues.addNote);
router.delete('/property/issues/:uuid/notes/:noteUuid', issues.removeNote);
// Google Nest thermostats, read-only (docs/capabilities/nest.md).
router.get('/property/thermostats', require('../controllers/propertyThermostats').list);
router.put('/property/thermostats/sleep-device', json, require('../controllers/propertyThermostats').setSleepDevice);
const security = require('../controllers/propertySecurity');
router.get('/property/security', security.list);
router.get('/property/security/devices/:serial/snapshot', security.snapshot);
router.post('/property/security/devices/:serial/clip', json, security.clip);
router.get('/property/security/media', security.listMedia);
router.get('/property/security/media/:id', security.getMedia);
router.patch('/property/security/media/:id', json, security.updateMedia);
router.delete('/property/security/media/:id', security.removeMedia);
// Sightings (docs/capabilities/sightings.md): gallery, camera zones, alert rules, log.
router.get('/property/security/sightings', security.sightingsOverview);
router.get('/property/security/sightings/:id/frame', security.sightingFrame);
router.post('/property/security/sightings/:id/teach', json, security.teachSighting);
router.post('/property/security/sightings/:id/entities', json, security.addSightingEntity);
router.post('/property/security/subjects', json, security.createSubject);
router.patch('/property/security/subjects/:id', json, security.updateSubject);
router.put('/property/security/subjects/:id/person', json, security.linkSubjectPerson);
router.delete('/property/security/subjects/:id', security.removeSubject);
router.post('/property/security/subjects/:id/photos', json, security.addSubjectPhoto);
router.delete('/property/security/subjects/:id/photos/:mediaId', security.removeSubjectPhoto);
router.put('/property/security/zones/:serial', json, security.setZones);
router.post('/property/security/rules', json, security.createRule);
router.patch('/property/security/rules/:id', json, security.updateRule);
router.delete('/property/security/rules/:id', security.removeRule);
// Guardian Engine: nightly sweep, storm umbrella watch, incidents (docs/architecture/guardian-engine.md).
const guardian = require('../controllers/guardian');
router.get('/property/security/guardian', guardian.overview);
router.put('/property/security/guardian/protocols/:id', json, guardian.saveProtocol);
router.post('/property/security/guardian/protocols/:id/run', json, guardian.runNow);
router.post('/property/security/guardian/incidents/:id/recheck', guardian.recheck);
router.post('/property/security/guardian/incidents/:id/acknowledge', guardian.acknowledge);
router.post('/property/security/guardian/incidents/:id/dismiss', json, guardian.dismiss);
router.put('/property/security/guardian/incidents/:id/assignee', json, guardian.assign);
// Vehicle photos are one 1.5 MB JPEG data URL; the same 8 MB parser covers them.
const vehicles = require('../controllers/propertyVehicles');
router.get('/property/vehicles', vehicles.list);
// Cars read through Smartcar (docs/capabilities/smartcar.md). Before /:uuid.
const smartcarCars = require('../controllers/propertySmartcar');
router.get('/property/vehicles/smartcar', smartcarCars.list);
router.patch('/property/vehicles/smartcar/:id', json, smartcarCars.update);
router.post('/property/vehicles', express.json({ limit: '4mb' }), vehicles.create);
router.patch('/property/vehicles/:uuid', express.json({ limit: '4mb' }), vehicles.update);
router.delete('/property/vehicles/:uuid', vehicles.remove);
router.get('/property/vehicles/:uuid/photo', vehicles.getPhoto);
router.post('/property/vehicles/:uuid/service', json, vehicles.addService);
router.delete('/property/vehicles/:uuid/service/:serviceUuid', vehicles.removeService);
router.patch('/property/vehicles/:uuid/recalls/:campaign', json, vehicles.setRecall);

// Property taxes and "Scan a bill" (docs/capabilities/property-taxes.md). The photo
// arrives as base64 JSON; the 8 MB parser in server.js covers /projects/property.
const taxes = require('../controllers/propertyTaxes');
const bills = require('../controllers/propertyBills');
router.get('/property/taxes', taxes.list);
router.patch('/property/taxes/:uuid/installments/:installmentUuid', json, taxes.setPaid);
router.delete('/property/taxes/:uuid', taxes.remove);
router.post('/property/bills/scan', bills.scan);
router.post('/property/bills/review', json, bills.review);

router.post('/concerns', json, c.createConcern);
router.patch('/concerns/:uuid', json, c.updateConcern);
router.delete('/concerns/:uuid', c.removeConcern);

router.put('/charters/:area', json, c.putCharter);
// The work-in-progress recommendation preference (a preference, never a limit).
router.put('/prefs', json, c.putPrefs);
router.get('/binding-options', c.bindingOptions);

router.patch('/:uuid', json, c.update);
router.delete('/:uuid', c.remove);

router.post('/:uuid/steps', json, c.addStep);
router.post('/:uuid/steps/reorder', json, c.reorderSteps);
router.patch('/:uuid/steps/:stepUuid', json, c.updateStep);
router.delete('/:uuid/steps/:stepUuid', c.removeStep);
// Step prerequisites: same project only, no self-edges, no cycles.
router.post('/:uuid/steps/:stepUuid/dependencies', json, c.addStepDependency);
router.delete('/:uuid/steps/:stepUuid/dependencies/:dependsOn', c.removeStepDependency);

// Work sessions: time set aside for the work. No calendar writes here — that is an approved action.
router.post('/:uuid/sessions', json, c.addSession);
router.patch('/:uuid/sessions/:sessionUuid', json, c.updateSession);
router.delete('/:uuid/sessions/:sessionUuid', c.removeSession);

// Specs (confirmed / pending verification) and the material takeoff.
router.post('/:uuid/items', json, c.addItem);
router.patch('/:uuid/items/:itemUuid', json, c.updateItem);
router.delete('/:uuid/items/:itemUuid', c.removeItem);

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
