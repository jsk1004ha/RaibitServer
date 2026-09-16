package recoverywire

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_Encoder_prefers_cancellation_returned_with_final_EOF(t *testing.T) {
	// Given
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelOnEOFReader{Reader: strings.NewReader("payload"), cancel: cancel}
	var encoded bytes.Buffer

	// When
	_, err := NewEncoder(DefaultLimits()).Encode(ctx, &encoded, Envelope{Metadata: mustMetadata(t), Payload: reader})

	// Then
	if !errors.Is(err, context.Canceled) || strings.Contains(encoded.String(), "\nE ") {
		t.Fatalf("error=%v terminal_written=%t", err, strings.Contains(encoded.String(), "\nE "))
	}
}

func Test_Encoder_prefers_cancellation_during_terminal_write(t *testing.T) {
	// Given
	ctx, cancel := context.WithCancel(context.Background())
	writer := &cancelOnWrite{cancel: cancel, cancelAt: 3}

	// When
	_, err := NewEncoder(DefaultLimits()).Encode(ctx, writer, Envelope{Metadata: mustMetadata(t), Payload: strings.NewReader("payload")})

	// Then
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Decoder_prefers_cancellation_returned_with_truncated_EOF(t *testing.T) {
	// Given
	encoded, _, err := encodePayload([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelOnEOFReader{Reader: strings.NewReader(strings.TrimSuffix(encoded, "\n")), cancel: cancel}

	// When
	_, err = NewDecoder(DefaultLimits()).Decode(ctx, io.Discard, reader)

	// Then
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Decoder_prefers_cancellation_during_terminal_EOF_check(t *testing.T) {
	// Given
	encoded, _, err := encodePayload([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelOnEOFReader{Reader: strings.NewReader(encoded), cancel: cancel}

	// When
	_, err = NewDecoder(DefaultLimits()).Decode(ctx, io.Discard, reader)

	// Then
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Codec_prefers_cancellation_when_writer_also_returns_an_error(t *testing.T) {
	// Given
	encoded, _, err := encodePayload([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	encodeCtx, cancelEncode := context.WithCancel(context.Background())
	decodeCtx, cancelDecode := context.WithCancel(context.Background())
	writeFailure := errors.New("writer failed")

	// When
	_, encodeErr := NewEncoder(DefaultLimits()).Encode(encodeCtx, &cancelOnWrite{cancel: cancelEncode, cancelAt: 1, err: writeFailure}, Envelope{
		Metadata: mustMetadata(t),
		Payload:  strings.NewReader("payload"),
	})
	_, decodeErr := NewDecoder(DefaultLimits()).Decode(
		decodeCtx,
		&cancelOnWrite{cancel: cancelDecode, cancelAt: 1, err: writeFailure},
		strings.NewReader(encoded),
	)

	// Then
	if !errors.Is(encodeErr, context.Canceled) || !errors.Is(decodeErr, context.Canceled) {
		t.Fatalf("encode=%v decode=%v", encodeErr, decodeErr)
	}
}

func Test_Encoder_stops_a_partial_write_immediately_after_cancellation(t *testing.T) {
	// Given
	ctx, cancel := context.WithCancel(context.Background())
	writer := &cancelAfterPartialWrite{cancel: cancel}

	// When
	_, err := NewEncoder(DefaultLimits()).Encode(ctx, writer, Envelope{
		Metadata: mustMetadata(t),
		Payload:  strings.NewReader("payload"),
	})

	// Then
	if !errors.Is(err, context.Canceled) || writer.calls != 1 {
		t.Fatalf("error=%v writes=%d", err, writer.calls)
	}
}

func Test_Decoder_stops_fragmented_reads_immediately_after_cancellation(t *testing.T) {
	// Given
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelAfterFragmentRead{cancel: cancel}

	// When
	_, err := NewDecoder(DefaultLimits()).Decode(ctx, io.Discard, reader)

	// Then
	if !errors.Is(err, context.Canceled) || reader.calls != 1 {
		t.Fatalf("error=%v reads=%d", err, reader.calls)
	}
}

type cancelOnEOFReader struct {
	io.Reader
	cancel context.CancelFunc
}

func (r *cancelOnEOFReader) Read(buffer []byte) (int, error) {
	n, err := r.Reader.Read(buffer)
	if errors.Is(err, io.EOF) {
		r.cancel()
	}
	return n, err
}

type cancelOnWrite struct {
	cancel   context.CancelFunc
	cancelAt int
	writes   int
	err      error
}

func (w *cancelOnWrite) Write(buffer []byte) (int, error) {
	w.writes++
	if w.writes == w.cancelAt {
		w.cancel()
	}
	return len(buffer), w.err
}

type cancelAfterPartialWrite struct {
	cancel context.CancelFunc
	calls  int
}

func (w *cancelAfterPartialWrite) Write([]byte) (int, error) {
	w.calls++
	if w.calls == 1 {
		w.cancel()
	}
	return 1, nil
}

type cancelAfterFragmentRead struct {
	cancel context.CancelFunc
	calls  int
}

func (r *cancelAfterFragmentRead) Read(buffer []byte) (int, error) {
	r.calls++
	if r.calls == 1 {
		r.cancel()
		return copy(buffer, "RAI"), nil
	}
	return 0, io.EOF
}
