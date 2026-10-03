package source

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// TemplateRequest identifies packaged content; it never accepts a source path or URL.
type TemplateRequest struct {
	CatalogID      string
	CatalogVersion string
	CatalogDigest  string
	SourceDigest   string
}

type TemplateMaterializer struct {
	catalogPath string
	bundlePath  string
}

type templateCatalog struct {
	Schema        string            `json:"schema"`
	CatalogDigest string            `json:"catalogDigest"`
	BundleDigest  string            `json:"bundleDigest"`
	Starters      []templateStarter `json:"starters"`
}

type templateStarter struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Source  struct {
		Digest string `json:"digest"`
	} `json:"source"`
}

type templateBundle struct {
	Schema  string           `json:"schema"`
	Sources []templateSource `json:"sources"`
}

type templateSource struct {
	ID      string         `json:"id"`
	Version string         `json:"version"`
	Digest  string         `json:"digest"`
	Files   []templateFile `json:"files"`
}

type templateFile struct {
	Path          string `json:"path"`
	Mode          string `json:"mode"`
	Size          int    `json:"size"`
	Digest        string `json:"digest"`
	ContentBase64 string `json:"contentBase64"`
	content       []byte
}

// Paths are trusted builder configuration, never deployment request fields.
func NewTemplateMaterializer(catalogPath, bundlePath string) *TemplateMaterializer {
	return &TemplateMaterializer{catalogPath: catalogPath, bundlePath: bundlePath}
}

// Materialize creates a fresh child of a builder-controlled workspace.
func (m *TemplateMaterializer) Materialize(ctx context.Context, request TemplateRequest, destination string) (result error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if m == nil || strings.TrimSpace(m.catalogPath) == "" || strings.TrimSpace(m.bundlePath) == "" {
		return errors.New("packaged template catalog and bundle are required")
	}
	if strings.TrimSpace(request.CatalogID) == "" || strings.TrimSpace(request.CatalogVersion) == "" {
		return errors.New("template catalog id/version is required")
	}
	catalogBytes, err := os.ReadFile(m.catalogPath)
	if err != nil {
		return fmt.Errorf("read packaged template catalog: %w", err)
	}
	bundleBytes, err := os.ReadFile(m.bundlePath)
	if err != nil {
		return fmt.Errorf("read packaged template bundle: %w", err)
	}
	var catalog templateCatalog
	if err := decodeExactJSON(catalogBytes, &catalog); err != nil || catalog.Schema != "raibitserver.starter-catalog/v1" {
		return errors.New("invalid packaged template catalog")
	}
	if request.CatalogDigest != catalog.CatalogDigest {
		return errors.New("template catalog digest mismatch")
	}
	if err := verifyCatalogDigest(catalogBytes, catalog.CatalogDigest); err != nil {
		return err
	}
	if digestBytes(bundleBytes) != catalog.BundleDigest {
		return errors.New("packaged template bundle digest mismatch")
	}
	starter, found := findStarter(catalog.Starters, request)
	if !found {
		return errors.New("template catalog id/version is not uniquely packaged")
	}
	if starter.Source.Digest != request.SourceDigest {
		return errors.New("template source digest mismatch")
	}
	var bundle templateBundle
	if err := decodeExactJSON(bundleBytes, &bundle); err != nil || bundle.Schema != "raibitserver.starter-source-bundle/v1" {
		return errors.New("invalid packaged template bundle")
	}
	source, found := findSource(bundle.Sources, request)
	if !found || source.Digest != request.SourceDigest {
		return errors.New("template source is not uniquely present in packaged bundle")
	}
	files, err := validateFiles(source.Files)
	if err != nil {
		return err
	}
	if sourceDigest(files) != request.SourceDigest {
		return errors.New("packaged template source content digest mismatch")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	parent, name, err := templateDestinationParent(destination)
	if err != nil {
		return err
	}
	defer parent.Close()
	if err := parent.Mkdir(name, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errors.New("template destination must not already exist")
		}
		return fmt.Errorf("create template destination: %w", err)
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, parent.RemoveAll(name))
		}
	}()
	root, err := parent.OpenRoot(name)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := filepath.FromSlash(file.Path)
		if err := root.MkdirAll(filepath.Dir(name), 0o700); err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if file.Mode == "0755" {
			mode = 0o755
		}
		output, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		_, writeErr := output.Write(file.content)
		modeErr := output.Chmod(mode)
		if err := errors.Join(writeErr, modeErr, output.Close()); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func templateDestinationParent(destination string) (*os.Root, string, error) {
	if destination == "" {
		return nil, "", errors.New("template destination is required")
	}
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return nil, "", err
	}
	parent := filepath.Dir(absolute)
	if absolute == parent {
		return nil, "", errors.New("template destination must be a workspace child")
	}
	// Reject even an ancestor symlink; OpenRoot then anchors all creation and cleanup.
	// The workspace and its ancestors are controlled by the builder, not tenants.
	for ancestor := parent; ; ancestor = filepath.Dir(ancestor) {
		info, err := os.Lstat(ancestor)
		if err != nil {
			return nil, "", err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, "", errors.New("template destination ancestors must be directories without symlinks")
		}
		if ancestor == filepath.Dir(ancestor) {
			break
		}
	}
	root, err := os.OpenRoot(parent)
	return root, filepath.Base(absolute), err
}

func validateFiles(files []templateFile) ([]templateFile, error) {
	if len(files) == 0 {
		return nil, errors.New("packaged template source has no files")
	}
	checked := append([]templateFile(nil), files...)
	seen := make(map[string]string)
	previous := ""
	for index := range checked {
		file := &checked[index]
		if file.Path <= previous || !safeTemplatePath(file.Path) || (file.Mode != "0644" && file.Mode != "0755") {
			return nil, errors.New("packaged template contains a non-canonical path or mode")
		}
		// Include directories, preventing file/ancestor conflicts and case aliases.
		parts := strings.Split(file.Path, "/")
		for index := range parts {
			name := strings.Join(parts[:index+1], "/")
			key := strings.ToLower(name)
			isFile := index == len(parts)-1
			if existing, found := seen[key]; found && (existing != name+"/" || isFile) {
				return nil, errors.New("packaged template contains duplicate or conflicting paths")
			}
			seen[key] = name
			if !isFile {
				seen[key] += "/"
			}
		}
		content, err := base64.StdEncoding.Strict().DecodeString(file.ContentBase64)
		if err != nil || base64.StdEncoding.EncodeToString(content) != file.ContentBase64 || len(content) != file.Size || digestBytes(content) != file.Digest {
			return nil, fmt.Errorf("packaged template file digest mismatch: %s", file.Path)
		}
		file.content = content
		previous = file.Path
	}
	return checked, nil
}

func safeTemplatePath(name string) bool {
	if !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, "\\:<>\"|?*\x00") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.TrimRight(part, ". ") != part {
			return false
		}
	}
	_, err := filepath.Localize(name)
	return err == nil
}

func sourceDigest(files []templateFile) string {
	hash := sha256.New()
	for _, file := range files {
		_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%d\x00", file.Path, file.Mode, len(file.content))
		_, _ = hash.Write(file.content)
		_, _ = hash.Write([]byte{0})
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil))
}

func findStarter(starters []templateStarter, request TemplateRequest) (match templateStarter, found bool) {
	for _, starter := range starters {
		if starter.ID == request.CatalogID && starter.Version == request.CatalogVersion {
			if found {
				return templateStarter{}, false
			}
			match, found = starter, true
		}
	}
	return match, found
}

func findSource(sources []templateSource, request TemplateRequest) (match templateSource, found bool) {
	for _, source := range sources {
		if source.ID == request.CatalogID && source.Version == request.CatalogVersion {
			if found {
				return templateSource{}, false
			}
			match, found = source, true
		}
	}
	return match, found
}

func decodeExactJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return errors.New("multiple JSON values are forbidden")
}

func verifyCatalogDigest(data []byte, expected string) error {
	var body map[string]any
	if err := decodeExactJSON(data, &body); err != nil {
		return errors.New("invalid packaged template catalog")
	}
	delete(body, "catalogDigest")
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil || digestBytes(bytes.TrimSuffix(canonical.Bytes(), []byte{'\n'})) != expected {
		return errors.New("packaged template catalog content digest mismatch")
	}
	return nil
}

func digestBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
