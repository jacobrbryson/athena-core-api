DROP TABLE IF EXISTS athena_alert_ack;
INSERT IGNORE INTO athena_incident_source (source) VALUES ('pulsepoint');
