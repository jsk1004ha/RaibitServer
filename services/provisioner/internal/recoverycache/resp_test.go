package recoverycache

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"testing"
)

func Test_Restore_RESP_encoder_preserves_binary_arguments(t *testing.T) {
	// Given
	var output bytes.Buffer

	// When
	err := writeCommand(&output, [][]byte{[]byte("RESTORE"), []byte("binary\x00key"), []byte("0"), []byte{0, 1, 2}})

	// Then
	if err != nil {
		t.Fatalf("write command: %v", err)
	}
	want := "*4\r\n$7\r\nRESTORE\r\n$10\r\nbinary\x00key\r\n$1\r\n0\r\n$3\r\n\x00\x01\x02\r\n"
	if got := output.String(); got != want {
		t.Fatalf("RESP = %q, want %q", got, want)
	}
}

func Test_Bounds_RESP_decoder_rejects_oversized_bulk(t *testing.T) {
	// Given
	input := bufio.NewReader(bytes.NewBufferString("$999999999\r\n"))

	// When
	_, err := readReply(input, 1024)

	// Then
	if !errors.Is(err, ErrRESP) {
		t.Fatalf("error = %v, want ErrRESP", err)
	}
}

func Test_Redaction_RESP_server_error_does_not_escape_raw_text(t *testing.T) {
	// Given
	input := bufio.NewReader(bytes.NewBufferString("-ERR top-secret cache.internal\r\n"))

	// When
	_, err := readReply(input, 1024)

	// Then
	if !errors.Is(err, ErrRESP) {
		t.Fatalf("error = %v, want ErrRESP", err)
	}
	if err.Error() != ErrRESP.Error() {
		t.Fatalf("raw server error escaped: %q", err)
	}
}

func Test_Cleanup_RESP_client_closes_transport(t *testing.T) {
	// Given
	transport := &trackingReadWriteCloser{reader: bytes.NewBufferString("+PONG\r\n")}
	client := newRESPClient(transport)

	// When
	_, err := client.command(t.Context(), []byte("PING"))
	closeErr := client.close()

	// Then
	if err != nil || closeErr != nil {
		t.Fatalf("command=%v close=%v", err, closeErr)
	}
	if !transport.closed {
		t.Fatal("transport was not closed")
	}
}

func Test_Capability_RESP_rejects_mismatched_engine_identity(t *testing.T) {
	// Given
	transport := &trackingReadWriteCloser{reader: bytes.NewBufferString("$31\r\n# Server\r\nredis_version:7.4.1\r\n\r\n")}
	client := newRESPClient(transport)
	defer func() {
		if err := client.close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}()

	// When
	_, err := client.version(t.Context(), engineValkey)

	// Then
	if !errors.Is(err, ErrOperation) {
		t.Fatalf("error = %v, want ErrOperation", err)
	}
}

func Test_RESP_accepts_matching_engine_identity(t *testing.T) {
	// Given
	transport := &trackingReadWriteCloser{reader: bytes.NewBufferString("$31\r\n# Server\r\nredis_version:7.4.1\r\n\r\n")}
	client := newRESPClient(transport)
	defer func() {
		if err := client.close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}()

	// When
	version, err := client.version(t.Context(), engineRedis)

	// Then
	if err != nil || version != "7.4.1" {
		t.Fatalf("version = %q, error = %v", version, err)
	}
}

func Test_RESP_reads_memory_and_requires_complete_RDB_load(t *testing.T) {
	// Given
	transport := &trackingReadWriteCloser{reader: bytes.NewBufferString("$25\r\n# Memory\r\nused_memory:9\r\n\r\n$53\r\n# Persistence\r\nloading:0\r\nrdb_last_bgsave_status:ok\r\n\r\n")}
	client := newRESPClient(transport)
	defer func() {
		if err := client.close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}()

	// When
	used, memoryErr := client.usedMemory(t.Context())
	readyErr := client.ready(t.Context())

	// Then
	if memoryErr != nil || used != 9 || readyErr != nil {
		t.Fatalf("used=%d memoryErr=%v readyErr=%v", used, memoryErr, readyErr)
	}
}

func Test_RESP_reads_server_TIME_and_absolute_expiry(t *testing.T) {
	// Given
	transport := &trackingReadWriteCloser{reader: bytes.NewBufferString("*2\r\n$10\r\n1800000000\r\n$6\r\n123000\r\n:1800000010000\r\n")}
	client := newRESPClient(transport)
	defer func() {
		if err := client.close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}()

	// When
	now, timeErr := client.serverTime(t.Context())
	deadline, expiryErr := client.expireTime(t.Context(), []byte("key"))

	// Then
	if timeErr != nil || expiryErr != nil || now != 1_800_000_000_123 || deadline != 1_800_000_010_000 {
		t.Fatalf("now=%d deadline=%d timeErr=%v expiryErr=%v", now, deadline, timeErr, expiryErr)
	}
}

func Test_RESP_rejects_malformed_TIME_and_PEXPIRETIME(t *testing.T) {
	// Given
	badTime := newRESPClient(&trackingReadWriteCloser{reader: bytes.NewBufferString("*2\r\n$1\r\n1\r\n$7\r\n1000000\r\n")})
	badExpiry := newRESPClient(&trackingReadWriteCloser{reader: bytes.NewBufferString(":-3\r\n")})

	// When
	_, timeErr := badTime.serverTime(t.Context())
	_, expiryErr := badExpiry.expireTime(t.Context(), []byte("key"))

	// Then
	if !errors.Is(timeErr, ErrOperation) || !errors.Is(expiryErr, ErrOperation) {
		t.Fatalf("time=%v expiry=%v", timeErr, expiryErr)
	}
}

func Test_RESP_rejects_TIME_millisecond_addition_overflow(t *testing.T) {
	// Given
	transport := &trackingReadWriteCloser{reader: bytes.NewBufferString("*2\r\n$16\r\n9223372036854775\r\n$6\r\n999999\r\n")}
	client := newRESPClient(transport)

	// When
	_, err := client.serverTime(t.Context())

	// Then
	if !errors.Is(err, ErrOperation) {
		t.Fatalf("error=%v", err)
	}
}

type trackingReadWriteCloser struct {
	reader io.Reader
	writes bytes.Buffer
	closed bool
}

func (t *trackingReadWriteCloser) Read(value []byte) (int, error)  { return t.reader.Read(value) }
func (t *trackingReadWriteCloser) Write(value []byte) (int, error) { return t.writes.Write(value) }
func (t *trackingReadWriteCloser) Close() error                    { t.closed = true; return nil }
