package recoveryreceipt

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func Test_StageStore_rejects_real_symlink_or_reparse_node(t *testing.T) {
	// Given
	directory := newStageTestDirectory(t)
	path := filepath.Join(directory, StageFileName)
	createStageReparse(t, directory, path)
	store := newStageStore(path, time.Now)

	// When
	_, err := store.consume(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("error=%v", err)
	}
}

func Test_StageStore_rejects_wrong_real_directory_permissions(t *testing.T) {
	// Given
	directory := newStageTestDirectory(t)
	makeStageObjectUnsafe(t, directory)
	path := filepath.Join(directory, StageFileName)
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validDumpStageSpec())
	if err != nil {
		t.Fatal(err)
	}

	// When
	err = store.write(stage)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("error=%v", err)
	}
}

func Test_StageStore_rejects_wrong_real_file_permissions(t *testing.T) {
	// Given
	directory := newStageTestDirectory(t)
	path := filepath.Join(directory, StageFileName)
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validDumpStageSpec())
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}
	makeStageObjectUnsafe(t, path)

	// When
	_, err = store.consume(EnginePostgreSQL, ActionPostgreSQLDump, DirectionDump)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("error=%v", err)
	}
}

func Test_StageStore_rejects_deterministic_replacement_race(t *testing.T) {
	// Given
	now := time.Unix(1_800_000_000, 0).UTC()
	directory := newStageTestDirectory(t)
	path := filepath.Join(directory, StageFileName)
	store := newStageStore(path, func() time.Time { return now })
	stage, err := NewStage(validStageSpec())
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}
	replacement, err := marshalStage(stage, now)
	if err != nil || os.WriteFile(filepath.Join(directory, "replacement.json"), replacement, 0o600) != nil {
		t.Fatalf("replacement setup error=%v", err)
	}
	store.beforeOpen = func(root *os.Root, claimed string) error {
		if err := root.Remove(claimed); err != nil {
			return err
		}
		return root.Rename("replacement.json", claimed)
	}

	// When
	_, err = store.consume(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("replacement accepted: %v", err)
	}
}

func Test_StageStore_write_is_exclusive(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validDumpStageSpec())
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}

	// When
	err = store.write(stage)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("existing stage overwritten: %v", err)
	}
}

func Test_StageStore_write_does_not_replace_invalid_existing_state(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	if err := os.WriteFile(path, []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validDumpStageSpec())
	if err != nil {
		t.Fatal(err)
	}

	// When
	err = store.write(stage)

	// Then
	contents, readErr := os.ReadFile(path)
	if !errors.Is(err, ErrStage) || readErr != nil || string(contents) != "invalid" {
		t.Fatalf("error=%v read=%v contents=%q", err, readErr, contents)
	}
}

func Test_StageStore_consumes_matching_state_exactly_once(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validDumpStageSpec())
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}

	// When
	_, firstErr := store.consume(EnginePostgreSQL, ActionPostgreSQLDump, DirectionDump)
	_, secondErr := store.consume(EnginePostgreSQL, ActionPostgreSQLDump, DirectionDump)

	// Then
	if firstErr != nil || !errors.Is(secondErr, ErrStage) {
		t.Fatalf("first=%v second=%v", firstErr, secondErr)
	}
}

func Test_StageStore_concurrent_write_has_exactly_one_winner(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validDumpStageSpec())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var writers sync.WaitGroup
	for range 2 {
		writers.Add(1)
		go func() {
			defer writers.Done()
			<-start
			results <- store.write(stage)
		}()
	}

	// When
	close(start)
	writers.Wait()
	close(results)

	// Then
	winners, rejected := 0, 0
	for result := range results {
		if result == nil {
			winners++
		} else if errors.Is(result, ErrStage) {
			rejected++
		}
	}
	if winners != 1 || rejected != 1 {
		t.Fatalf("winners=%d rejected=%d", winners, rejected)
	}
}
