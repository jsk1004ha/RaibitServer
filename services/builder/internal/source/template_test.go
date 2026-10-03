package source

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const catalogDigest = "sha256:fa54ee625c526450d7df2fc752059b7166de52f8c32b7b07b4b0f7212b6ddd1a"

func TestTemplateMaterializerUsesExactPackagedSource(t *testing.T) {
	t.Parallel()
	materializer := NewTemplateMaterializer(
		filepath.Join("..", "..", "..", "..", "test-fixtures", "contracts", "starter-catalog-v1.json"),
		filepath.Join("..", "..", "..", "..", "test-fixtures", "contracts", "starter-catalog-v1.bundle.json"),
	)
	for id, digest := range map[string]string{
		"discord-bot":   "sha256:aeffdb61da815027b40e14aa2b99d6cfa17f53f12ec1d56fcc6f121af970f4a6",
		"fastapi":       "sha256:18a5bff72874736f820ead48cf869c3464a91e72e616528bdacda673c5a7e3d5",
		"next-postgres": "sha256:ee3ac8cc04997bbaee95f4ea254afeedbcdb55a799664e91fc5cf3855f527b2d",
	} {
		t.Run(id, func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "source")
			request := TemplateRequest{CatalogID: id, CatalogVersion: "v1", CatalogDigest: catalogDigest, SourceDigest: digest}
			if err := materializer.Materialize(context.Background(), request, destination); err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(filepath.Join(destination, "Dockerfile"))
			if err != nil || !strings.Contains(string(content), "HEALTHCHECK") {
				t.Fatalf("missing packaged Dockerfile health check: %v", err)
			}
			if err := materializer.Materialize(context.Background(), request, destination); err == nil {
				t.Fatal("replay must reject an existing destination")
			}
			unchanged, err := os.ReadFile(filepath.Join(destination, "Dockerfile"))
			if err != nil || string(unchanged) != string(content) {
				t.Fatal("failed replay changed existing source")
			}
		})
	}
}

func TestTemplateMaterializerRejectsInvalidRequestAndArtifacts(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		mutate func(*TemplateMaterializer, *TemplateRequest)
	}{
		{"unknown id", func(_ *TemplateMaterializer, r *TemplateRequest) { r.CatalogID = "../remote" }},
		{"unknown version", func(_ *TemplateMaterializer, r *TemplateRequest) { r.CatalogVersion = "v2" }},
		{"catalog digest", func(_ *TemplateMaterializer, r *TemplateRequest) {
			r.CatalogDigest = "sha256:" + strings.Repeat("0", 64)
		}},
		{"source digest", func(_ *TemplateMaterializer, r *TemplateRequest) {
			r.SourceDigest = "sha256:" + strings.Repeat("0", 64)
		}},
		{"catalog content", func(m *TemplateMaterializer, _ *TemplateRequest) {
			data, err := os.ReadFile(m.catalogPath)
			if err != nil {
				t.Fatal(err)
			}
			writeTestFile(t, m.catalogPath, []byte(strings.Replace(string(data), `"id":"fixture"`, `"id":"changed"`, 1)))
		}},
		{"bundle content", func(m *TemplateMaterializer, _ *TemplateRequest) {
			data, err := os.ReadFile(m.bundlePath)
			if err != nil {
				t.Fatal(err)
			}
			writeTestFile(t, m.bundlePath, append(data, '\n'))
		}},
		{"multiple catalog values", func(m *TemplateMaterializer, _ *TemplateRequest) {
			data, err := os.ReadFile(m.catalogPath)
			if err != nil {
				t.Fatal(err)
			}
			writeTestFile(t, m.catalogPath, append(data, []byte(" {}")...))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			materializer, request := templateTestPackage(t, nil)
			test.mutate(materializer, &request)
			assertTemplateRejected(t, materializer, request)
		})
	}
	materializer, request := templateTestPackage(t, nil)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	destination := filepath.Join(t.TempDir(), "source")
	if err := materializer.Materialize(cancelled, request, destination); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	assertTemplateAbsent(t, destination)
}

func TestTemplateMaterializerRejectsMalformedFilesBeforeWriting(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"", ".", "..", "../escape", "dir/../escape", "dir/./file", "dir//file", "/absolute", "dir/", `dir\file`, `C:\escape`, "C:escape", "file:stream", "file\x00tail", "dir./file", "file "} {
		t.Run("path "+name, func(t *testing.T) {
			materializer, request := templateTestPackage(t, func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[0].Path = name })
			assertTemplateRejected(t, materializer, request)
		})
	}
	for _, test := range []struct {
		name   string
		mutate func(*templateCatalog, *templateBundle)
	}{
		{"empty files", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files = nil }},
		{"invalid mode", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[0].Mode = "0777" }},
		{"invalid base64", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[0].ContentBase64 = "?" }},
		{"base64 newline", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[0].ContentBase64 += "\n" }},
		{"wrong size", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[0].Size++ }},
		{"wrong file hash", func(_ *templateCatalog, b *templateBundle) {
			b.Sources[0].Files[0].Digest = "sha256:" + strings.Repeat("0", 64)
		}},
		{"duplicate file", func(_ *templateCatalog, b *templateBundle) {
			b.Sources[0].Files = append(b.Sources[0].Files[:1], b.Sources[0].Files[0])
		}},
		{"unsorted files", func(_ *templateCatalog, b *templateBundle) {
			b.Sources[0].Files[0], b.Sources[0].Files[1] = b.Sources[0].Files[1], b.Sources[0].Files[0]
		}},
		{"file ancestor conflict", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[1].Path = "Dockerfile/nested" }},
		{"case conflict", func(_ *templateCatalog, b *templateBundle) { b.Sources[0].Files[1].Path = "dockerfile" }},
		{"case directory conflict", func(_ *templateCatalog, b *templateBundle) {
			b.Sources[0].Files[0].Path = "Dir/a"
			b.Sources[0].Files[1].Path = "dir/b"
		}},
		{"duplicate starter", func(c *templateCatalog, _ *templateBundle) { c.Starters = append(c.Starters, c.Starters[0]) }},
		{"duplicate source", func(_ *templateCatalog, b *templateBundle) { b.Sources = append(b.Sources, b.Sources[0]) }},
		{"bundle schema", func(_ *templateCatalog, b *templateBundle) { b.Schema = "unsupported" }},
		{"catalog schema", func(c *templateCatalog, _ *templateBundle) { c.Schema = "unsupported" }},
		{"source content hash", func(c *templateCatalog, b *templateBundle) {
			c.Starters[0].Source.Digest = "sha256:" + strings.Repeat("0", 64)
			b.Sources[0].Digest = c.Starters[0].Source.Digest
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			materializer, request := templateTestPackage(t, test.mutate)
			assertTemplateRejected(t, materializer, request)
		})
	}
}

func TestTemplateMaterializerPreservesExistingDestinations(t *testing.T) {
	t.Parallel()
	materializer, request := templateTestPackage(t, nil)
	for _, kind := range []string{"file", "directory", "symlink", "dangling symlink", "ancestor symlink", "ancestor file"} {
		t.Run(kind, func(t *testing.T) {
			workspace := t.TempDir()
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "keep")
			writeTestFile(t, sentinel, []byte("preserve"))
			destination := filepath.Join(workspace, "source")
			switch kind {
			case "file":
				writeTestFile(t, destination, []byte("existing"))
			case "directory":
				if err := os.Mkdir(destination, 0o700); err != nil {
					t.Fatal(err)
				}
				writeTestFile(t, filepath.Join(destination, "keep"), []byte("existing"))
			case "symlink", "dangling symlink":
				target := outside
				if kind == "dangling symlink" {
					target = filepath.Join(outside, "missing")
				}
				if err := os.Symlink(target, destination); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
			case "ancestor symlink":
				link := filepath.Join(workspace, "link")
				if err := os.Symlink(outside, link); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
				destination = filepath.Join(link, "source")
			case "ancestor file":
				file := filepath.Join(workspace, "file")
				writeTestFile(t, file, []byte("existing"))
				destination = filepath.Join(file, "source")
			}
			if err := materializer.Materialize(context.Background(), request, destination); err == nil {
				t.Fatal("unsafe destination was accepted")
			}
			content, err := os.ReadFile(sentinel)
			if err != nil || string(content) != "preserve" {
				t.Fatal("existing external file was changed")
			}
			entries, err := os.ReadDir(outside)
			if err != nil || len(entries) != 1 {
				t.Fatalf("wrote through symlink: %v", err)
			}
			switch kind {
			case "file":
				content, err = os.ReadFile(destination)
			case "directory":
				content, err = os.ReadFile(filepath.Join(destination, "keep"))
			case "ancestor file":
				content, err = os.ReadFile(filepath.Join(workspace, "file"))
			default:
				link := destination
				if kind == "ancestor symlink" {
					link = filepath.Join(workspace, "link")
				}
				info, err := os.Lstat(link)
				if err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatal("existing symlink was removed")
				}
				return
			}
			if err != nil || string(content) != "existing" {
				t.Fatal("existing destination was changed")
			}
		})
	}
}

func TestTemplateMaterializerPreservesNestedContentAndExecutableMode(t *testing.T) {
	t.Parallel()
	materializer, request := templateTestPackage(t, nil)
	destination := filepath.Join(t.TempDir(), "source")
	if err := materializer.Materialize(context.Background(), request, destination); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(destination, "scripts", "start.sh")
	content, err := os.ReadFile(name)
	if err != nil || string(content) != "#!/bin/sh\necho ready\n" {
		t.Fatalf("wrong nested file content: %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(name)
		if err != nil || info.Mode().Perm() != 0o755 {
			t.Fatalf("wrong executable mode: %v", err)
		}
	}
}

func templateTestPackage(t *testing.T, mutate func(*templateCatalog, *templateBundle)) (*TemplateMaterializer, TemplateRequest) {
	t.Helper()
	files := []templateFile{}
	for _, entry := range []struct{ path, mode, content string }{
		{"Dockerfile", "0644", "FROM scratch\n"},
		{"scripts/start.sh", "0755", "#!/bin/sh\necho ready\n"},
	} {
		content := []byte(entry.content)
		files = append(files, templateFile{Path: entry.path, Mode: entry.mode, Size: len(content), Digest: digestBytes(content), ContentBase64: base64.StdEncoding.EncodeToString(content), content: content})
	}
	bundle := templateBundle{Schema: "raibitserver.starter-source-bundle/v1", Sources: []templateSource{{ID: "fixture", Version: "v1", Digest: sourceDigest(files), Files: files}}}
	catalog := templateCatalog{Schema: "raibitserver.starter-catalog/v1", Starters: []templateStarter{{ID: "fixture", Version: "v1"}}}
	catalog.Starters[0].Source.Digest = bundle.Sources[0].Digest
	originalDigest := bundle.Sources[0].Digest
	if mutate != nil {
		mutate(&catalog, &bundle)
	}
	// Structural corruptions retain valid enclosing hashes, so their own guard
	// must reject them. Preserve deliberately corrupted source digest cases.
	if catalog.Starters[0].Source.Digest == originalDigest && bundle.Sources[0].Digest == originalDigest {
		bundle.Sources[0].Digest = sourceDigest(bundle.Sources[0].Files)
		catalog.Starters[0].Source.Digest = bundle.Sources[0].Digest
	}
	bundleBytes, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	catalog.BundleDigest = digestBytes(bundleBytes)
	catalogBytes, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(catalogBytes, &body); err != nil {
		t.Fatal(err)
	}
	delete(body, "catalogDigest")
	canonical, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	catalog.CatalogDigest = digestBytes(canonical)
	catalogBytes, err = json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	materializer := NewTemplateMaterializer(filepath.Join(directory, "catalog.json"), filepath.Join(directory, "bundle.json"))
	writeTestFile(t, materializer.catalogPath, catalogBytes)
	writeTestFile(t, materializer.bundlePath, bundleBytes)
	return materializer, TemplateRequest{CatalogID: "fixture", CatalogVersion: "v1", CatalogDigest: catalog.CatalogDigest, SourceDigest: catalog.Starters[0].Source.Digest}
}

func assertTemplateRejected(t *testing.T, materializer *TemplateMaterializer, request TemplateRequest) {
	t.Helper()
	destination := filepath.Join(t.TempDir(), "source")
	if err := materializer.Materialize(context.Background(), request, destination); err == nil {
		t.Fatal("expected materialization rejection")
	}
	assertTemplateAbsent(t, destination)
}

func assertTemplateAbsent(t *testing.T, destination string) {
	t.Helper()
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected template created destination: %v", err)
	}
}

func writeTestFile(t *testing.T, name string, content []byte) {
	t.Helper()
	if err := os.WriteFile(name, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
