package backup

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

// Cleanup is restartable and scoped to one server-derived attempt. The store must
// retain its intent until BOTH result flags are true and its final deletion fence
// commits. A truncated/unsupported listing is pending, never proof of absence.
func (s *Service) Cleanup(ctx context.Context, req CleanupRequest, authorizer CleanupAuthorizer) (CleanupResult, error) {
	result := CleanupResult{}
	if _, err := NewAttempt(req.Attempt.spec); err != nil {
		return result, err
	}
	if authorizer == nil || len(req.UploadID) > 1024 {
		return result, ErrConfig
	}
	bounded, cancel := context.WithTimeout(ctx, MaxDuration)
	defer cancel()
	if err := authorizer.AuthorizeCleanup(bounded, req.Attempt); err != nil {
		return result, ErrFence
	}
	if err := s.resolveCleanupCompletion(bounded, req, authorizer); err != nil {
		return result, err
	}
	key := req.Attempt.ObjectKey()
	uploads, err := s.client.ListMultipartUploads(bounded, &s3.ListMultipartUploadsInput{Bucket: aws.String(s.bucket), Prefix: aws.String(key), MaxUploads: aws.Int32(100)})
	if err != nil {
		return result, errors.Join(ErrCleanupPending, safeError(err))
	}
	if uploads.IsTruncated == nil || len(uploads.Uploads) > 100 {
		return result, ErrCleanupPending
	}
	ids := make(map[string]bool)
	if req.UploadID != "" {
		ids[req.UploadID] = true
	}
	for _, upload := range uploads.Uploads {
		if aws.ToString(upload.Key) != key {
			continue
		}
		id := aws.ToString(upload.UploadId)
		if !boundedSecret(id, 1024) {
			return result, errors.Join(ErrCleanupPending, ErrBackend)
		}
		ids[id] = true
	}
	for id := range ids {
		if err := authorizer.AuthorizeCleanup(bounded, req.Attempt); err != nil {
			return result, errors.Join(ErrCleanupPending, ErrFence)
		}
		_, err := s.client.AbortMultipartUpload(bounded, &s3.AbortMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(id)})
		if err != nil && !apiCode(err, "NoSuchUpload") {
			return result, errors.Join(ErrCleanupPending, safeError(err))
		}
		parts, err := s.client.ListParts(bounded, &s3.ListPartsInput{Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(id), MaxParts: aws.Int32(1)})
		if err != nil && !apiCode(err, "NoSuchUpload") {
			return result, errors.Join(ErrCleanupPending, safeError(err))
		}
		if err == nil && (parts.IsTruncated == nil || len(parts.Parts) > 0 || aws.ToBool(parts.IsTruncated)) {
			return result, ErrCleanupPending
		}
	}
	if aws.ToBool(uploads.IsTruncated) {
		return result, ErrCleanupPending
	}
	result.MultipartAbsent = true
	versions, err := s.client.ListObjectVersions(bounded, &s3.ListObjectVersionsInput{Bucket: aws.String(s.bucket), Prefix: aws.String(key), MaxKeys: aws.Int32(100)})
	if err != nil {
		return result, errors.Join(ErrCleanupPending, safeError(err))
	}
	if versions.IsTruncated == nil || len(versions.Versions)+len(versions.DeleteMarkers) > 100 {
		return result, ErrCleanupPending
	}
	versionIDs := make(map[string]bool)
	for _, version := range versions.Versions {
		if aws.ToString(version.Key) == key {
			versionIDs[aws.ToString(version.VersionId)] = true
		}
	}
	for _, marker := range versions.DeleteMarkers {
		if aws.ToString(marker.Key) == key {
			versionIDs[aws.ToString(marker.VersionId)] = true
		}
	}
	for id := range versionIDs {
		if !boundedSecret(id, 1024) {
			return result, errors.Join(ErrCleanupPending, ErrBackend)
		}
		if err := authorizer.AuthorizeCleanup(bounded, req.Attempt); err != nil {
			return result, errors.Join(ErrCleanupPending, ErrFence)
		}
		_, err := s.client.DeleteObject(bounded, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), VersionId: aws.String(id)})
		if err != nil {
			return result, errors.Join(ErrCleanupPending, safeError(err))
		}
	}
	if aws.ToBool(versions.IsTruncated) {
		return result, ErrCleanupPending
	}
	// Unversioned objects are represented as version "null" by ListObjectVersions.
	// Do not send an unqualified DELETE: it would create a new versioned marker.
	result.ObjectAbsent = true
	return result, nil
}

func apiCode(err error, code string) bool {
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == code
}
