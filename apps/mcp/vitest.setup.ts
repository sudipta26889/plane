// Config reads process.env at module load. These values are never used to
// reach a real service — every test stubs fetch — but they must be present
// so the "not configured" guards do not fire during tests.
process.env.EMBEDDING_DIRECT_URL ||= "http://embeddings.test/embed";
process.env.QDRANT_URL ||= "http://qdrant.test";
process.env.QDRANT_API_KEY ||= "test-key";
process.env.QDRANT_COLLECTION_NAME ||= "test_collection";
process.env.MQTT_HOST ||= "mqtt.test";
process.env.MQTT_USERNAME ||= "test-user";
process.env.MQTT_PASSWORD ||= "test-pass";
