package backup

import (
	"slices"
	"testing"
)

func Test_RecoveryAdapterBindings_rehydrate_engine_specific_metadata(t *testing.T) {
	tests := []struct {
		name     string
		adapter  RecoveryAdapter
		binding  func(RecoveryAdapter) (RecoveryAdapterBinding, error)
		source   func(*testing.T) Connection
		artifact func(*testing.T, RecoveryAdapter, Connection) (RecoveryArtifact, IsolatedJob)
	}{
		{
			name:    "mongodb",
			adapter: NewMongoDBRecoveryAdapter(),
			binding: NewMongoDBRecoveryAdapterBinding,
			source: func(t *testing.T) Connection {
				return mongoConnection(t, "source", "source.mongodb.internal", "app", "provider", "7.0.14")
			},
			artifact: mongoArtifact,
		},
		{
			name:    "redis",
			adapter: NewRedisRecoveryAdapter(),
			binding: NewCacheRecoveryAdapterBinding,
			source: func(t *testing.T) Connection {
				return cacheConnection(t, EngineRedis, "source", "source.redis.internal", "7.2.4")
			},
			artifact: cacheArtifact,
		},
		{
			name:    "valkey",
			adapter: NewValkeyRecoveryAdapter(),
			binding: NewCacheRecoveryAdapterBinding,
			source: func(t *testing.T) Connection {
				return cacheConnection(t, EngineValkey, "source", "source.valkey.internal", "8.0.1")
			},
			artifact: cacheArtifact,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			source := test.source(t)
			artifact, _ := test.artifact(t, test.adapter, source)
			binding, err := test.binding(test.adapter)
			if err != nil {
				t.Fatal(err)
			}

			// When
			rehydrated, err := binding.rehydrator.Rehydrate(source, VerifiedArtifact{record: artifact.Record()})

			// Then
			if err != nil || rehydrated.Format().Spec() != artifact.Format().Spec() || rehydrated.Baseline().Spec().Schema != artifact.Baseline().Spec().Schema || !slices.Equal(rehydrated.Baseline().Spec().Fields, artifact.Baseline().Spec().Fields) {
				t.Fatalf("rehydrated=%+v err=%v", rehydrated, err)
			}
		})
	}
}
