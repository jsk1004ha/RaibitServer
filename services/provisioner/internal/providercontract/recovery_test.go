package providercontract

import "testing"

func TestRecoveryForUsesCanonicalProviderEndpointAndCredential(t *testing.T) {
	tests := []struct {
		engine, key string
		port        uint16
		indexed     bool
	}{
		{"postgresql", "PGPASSWORD", 5432, false},
		{"mysql", "MYSQL_PASSWORD", 3306, false},
		{"mariadb", "MYSQL_PASSWORD", 3306, false},
		{"mongodb", "MONGO_PASSWORD", 27017, false},
		{"redis", "REDIS_PASSWORD", 6379, true},
		{"valkey", "REDIS_PASSWORD", 6379, true},
	}
	for _, test := range tests {
		t.Run(test.engine, func(t *testing.T) {
			contract, err := RecoveryFor(test.engine, "provider-db", "tenant", "Customer DB", map[string]any{"databaseName": "Customer Data", "username": "App Owner"})
			if err != nil || contract.Host != "provider-db.tenant.svc.cluster.local" || contract.Port != test.port || contract.CredentialKey != test.key || (contract.Index != nil) != test.indexed {
				t.Fatalf("contract=%+v err=%v", contract, err)
			}
			if !test.indexed && (contract.Database != "customer_data" || contract.User != "app_owner") {
				t.Fatalf("server-owned identifiers were not normalized: %+v", contract)
			}
		})
	}
}
