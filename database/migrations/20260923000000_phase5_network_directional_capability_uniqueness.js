/* Phase 5.8 Step 1 correction: Phase 2's generic active-capability index is incompatible with directional REFER grants. */
exports.up = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS network_connection_capabilities_active_unique');
};

exports.down = (pgm) => {
  pgm.sql("CREATE UNIQUE INDEX network_connection_capabilities_active_unique ON network_connection_capabilities (network_connection_id, capability_key) WHERE status = 'ACTIVE'");
};
