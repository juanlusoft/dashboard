/**
 * HomePiNAS - Storage Routes (Barrel)
 * 
 * Split into modules for maintainability:
 *   pool.js          - Pool status & capacity
 *   wizard.js        - Pool configuration wizard
 *   snapraid.js      - SnapRAID sync/scrub/status
 *   cache.js         - SSD cache management
 *   file-location.js - File disk location lookup
 *   disks.js         - Disk add/remove/mount/ignore
 *   config.js        - Storage config endpoint
 *   smart.js         - SMART health data & tests
 *   badblocks.js     - Bad blocks scanning
 */

const express = require('express');
const router = express.Router();

router.use('/', require('./pool'));
router.use('/', require('./wizard'));
router.use('/', require('./snapraid'));
router.use('/', require('./cache'));
router.use('/', require('./file-location'));
router.use('/', require('./disks'));
router.use('/', require('./config'));
router.use('/', require('./smart'));
router.use('/', require('./badblocks'));

module.exports = router;
