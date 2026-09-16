package backup

import (
	"io"
	"testing"

	"github.com/tink-crypto/tink-go/v2/streamingaead/subtle"
)

func Test_TinkCompatibility_when_hkdf_algorithm_named(t *testing.T) {
	for _, name := range []string{"HmacSha256", "SHA256"} {
		t.Run(name, func(t *testing.T) {
			// Given: v2.8.0 API documentation names HmacSha256, source uses SHA256.
			primitive, err := subtle.NewAESGCMHKDF(make([]byte, 32), name, 32, SegmentBytes, 0)
			if err != nil {
				t.Fatal(err)
			}
			// When: construction proceeds to key derivation in writer initialization.
			writer, err := primitive.NewEncryptingWriter(io.Discard, []byte("public-fixture-aad"))
			// Then: the actual pinned implementation accepts only SHA256 spelling.
			if name == "HmacSha256" {
				if err == nil {
					if closeErr := writer.Close(); closeErr != nil {
						t.Fatal(closeErr)
					}
					t.Fatal("documented spelling unexpectedly accepted")
				}
				t.Logf("documented_name_rejected=true error=%s", err)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
