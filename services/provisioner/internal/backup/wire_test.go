package backup

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type wireStore struct {
	mu           sync.Mutex
	t            *testing.T
	journal      *testJournal
	key          string
	mode         string
	parts        map[int][]byte
	object       []byte
	uploadActive bool
	events       []string
	conditional  bool
	signed       bool
	readBytes    int
	writeErrors  int
	delay        *delayedWrite
}

func (w *wireStore) serve(response http.ResponseWriter, request *http.Request) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !strings.HasPrefix(request.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=local-access/") || request.Header.Get("X-Amz-Date") == "" {
		w.t.Error("SDK request was not explicitly signed")
	}
	w.signed = true
	q := request.URL.Query()
	switch {
	case request.Method == "POST" && q.Has("uploads"):
		w.journal.mu.Lock()
		intended := w.journal.intent
		w.journal.mu.Unlock()
		if !intended {
			w.t.Error("create preceded durable intent")
		}
		w.events = append(w.events, "create")
		w.uploadActive = true
		if w.mode == "create-unknown" {
			w.fail(response, 500)
			return
		}
		w.xml(response, `<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>`)
	case request.Method == "PUT":
		w.journal.mu.Lock()
		persisted := w.journal.upload
		w.journal.mu.Unlock()
		if !persisted {
			w.t.Error("part preceded durable upload ID")
		}
		w.events = append(w.events, "part")
		if w.mode == "part-fail" {
			w.fail(response, 500)
			return
		}
		part, err := strconv.Atoi(q.Get("partNumber"))
		if err != nil {
			w.t.Error(err)
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, PartBytes+1))
		if err != nil || len(body) > PartBytes {
			w.t.Error("unbounded or unreadable SDK part")
			return
		}
		w.parts[part] = body
		response.Header().Set("ETag", fmt.Sprintf(`"part-%d"`, part))
	case request.Method == "POST" && q.Has("uploadId"):
		w.journal.mu.Lock()
		recorded := w.journal.candidate.record.StoredBytes > 0
		w.journal.mu.Unlock()
		if !recorded {
			w.t.Error("complete preceded durable descriptor")
		}
		w.events = append(w.events, "complete")
		w.conditional = request.Header.Get("If-None-Match") == "*"
		if !w.conditional {
			w.t.Error("missing conditional complete")
		}
		if w.mode == "complete-unsupported" {
			w.fail(response, 501)
			return
		}
		if w.mode == "complete-conflict" || w.object != nil {
			w.fail(response, 412)
			return
		}
		var complete struct {
			Parts []struct {
				Number int    `xml:"PartNumber"`
				ETag   string `xml:"ETag"`
			} `xml:"Part"`
		}
		if err := xml.NewDecoder(request.Body).Decode(&complete); err != nil {
			w.t.Error(err)
			return
		}
		for i, part := range complete.Parts {
			if part.Number != i+1 || part.ETag != fmt.Sprintf(`"part-%d"`, part.Number) {
				w.t.Error("invalid SDK completion manifest")
			}
			w.object = append(w.object, w.parts[part.Number]...)
		}
		w.uploadActive = false
		if w.mode == "complete-unknown" {
			w.fail(response, 500)
			return
		}
		w.xml(response, `<CompleteMultipartUploadResult><ETag>"opaque"</ETag></CompleteMultipartUploadResult>`)
	case request.Method == "GET" && q.Has("uploads"):
		w.events = append(w.events, "list-uploads")
		if q.Get("prefix") != w.key {
			w.t.Error("multipart listing was not exact-key scoped")
		}
		if w.mode == "list-fail" {
			w.fail(response, 501)
			return
		}
		body := `<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>`
		if w.uploadActive {
			body += `<Upload><Key>` + w.key + `</Key><UploadId>upload-1</UploadId></Upload>`
		}
		body += `<Upload><Key>` + w.key + `-other</Key><UploadId>foreign</UploadId></Upload>`
		if w.mode == "list-truncated" {
			body = strings.Replace(body, "false", "true", 1)
		}
		if w.mode == "list-overflow" {
			body += strings.Repeat(`<Upload><Key>`+w.key+`</Key><UploadId>upload-1</UploadId></Upload>`, 101)
		}
		w.xml(response, body+`</ListMultipartUploadsResult>`)
	case request.Method == "GET" && q.Has("versions"):
		w.events = append(w.events, "list-versions")
		if q.Get("prefix") != w.key {
			w.t.Error("version listing was not exact-key scoped")
		}
		body := `<ListVersionsResult><IsTruncated>false</IsTruncated>`
		if w.object != nil {
			body += `<Version><Key>` + w.key + `</Key><VersionId>null</VersionId></Version>`
		}
		if w.mode == "versioned" {
			body += `<Version><Key>` + w.key + `</Key><VersionId>old</VersionId></Version><DeleteMarker><Key>` + w.key + `</Key><VersionId>marker</VersionId></DeleteMarker>`
		}
		body += `<Version><Key>` + w.key + `-other</Key><VersionId>foreign</VersionId></Version>`
		if w.mode == "version-overflow" {
			body += strings.Repeat(`<Version><Key>`+w.key+`</Key><VersionId>null</VersionId></Version>`, 101)
		}
		if w.mode == "version-truncated" {
			body = strings.Replace(body, "false", "true", 1)
		}
		w.xml(response, body+`</ListVersionsResult>`)
	case request.Method == "GET" && q.Has("uploadId"):
		w.events = append(w.events, "list-parts")
		if q.Get("uploadId") != "upload-1" {
			w.t.Error("foreign parts lookup")
		}
		if w.mode == "parts-remain" {
			w.xml(response, `<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber></Part></ListPartsResult>`)
			return
		}
		response.WriteHeader(404)
		w.xml(response, `<Error><Code>NoSuchUpload</Code></Error>`)
	case request.Method == "GET":
		w.events = append(w.events, "get")
		if w.object == nil {
			w.fail(response, 404)
			return
		}
		response.Header().Set("Content-Length", strconv.Itoa(len(w.object)))
		if w.mode == "get-truncated" {
			if _, err := response.Write(w.object[:len(w.object)/2]); err != nil {
				w.t.Error(err)
			}
			return
		}
		n, err := response.Write(w.object)
		if err != nil {
			w.writeErrors++
		}
		w.readBytes += n
	case request.Method == "DELETE" && q.Has("uploadId"):
		w.requireCompletion()
		w.events = append(w.events, "abort")
		if q.Get("uploadId") != "upload-1" {
			w.t.Error("foreign multipart abort")
		}
		if w.mode == "abort-fail" {
			w.fail(response, 500)
			return
		}
		w.uploadActive = false
		response.WriteHeader(204)
	case request.Method == "DELETE":
		w.requireCompletion()
		w.events = append(w.events, "delete-"+q.Get("versionId"))
		if q.Get("versionId") == "" || q.Get("versionId") == "foreign" {
			w.t.Error("unqualified or foreign version deletion")
		}
		if w.mode == "delete-fail" {
			w.fail(response, 500)
			return
		}
		w.object = nil
		if w.mode == "delete-unknown" {
			w.fail(response, 500)
			return
		}
		response.WriteHeader(204)
	default:
		w.t.Errorf("unexpected SDK operation %s", request.Method)
		w.fail(response, 400)
	}
}

func (w *wireStore) xml(response http.ResponseWriter, body string) {
	response.Header().Set("Content-Type", "application/xml")
	if _, err := io.WriteString(response, body); err != nil {
		w.t.Error(err)
	}
}

func (w *wireStore) fail(response http.ResponseWriter, status int) {
	response.WriteHeader(status)
	w.xml(response, `<Error><Code>BackendFailure</Code><Message>SECRET-BACKEND-BODY</Message></Error>`)
}
