# 호스팅 오류 화면

RAIBITSERVER는 대시보드 오류와 호스팅 인프라 오류를 같은 상태 체계로 표시합니다. 사용자의 애플리케이션이 직접 만든 오류 화면은 존중하고, 플랫폼 라우팅이나 upstream 연결에서 발생한 오류만 공통 화면으로 대체합니다.

## 적용 범위

| 상황 | 처리 |
| --- | --- |
| 존재하지 않는 대시보드 경로 | 공개 404 화면 |
| 대시보드 렌더링 실패 | 500 화면, 재시도, 안전한 기술 식별자 |
| 존재하지 않는 `apps--*` / `preview--*` 주소 | wildcard fallback 404 화면 |
| 호스팅 upstream 500, 502, 503, 504 | Ingress 오류 middleware/backend가 상태 코드를 유지한 공통 화면 반환 |
| 사용자 앱이 직접 반환한 404 | 기본적으로 사용자 앱 응답 유지 |

미리보기와 오류 backend는 IANA에 등록된 활성 HTTP 오류 38종을 지원합니다.

- 4xx 28종: `400`, `401`, `402`, `403`, `404`, `405`, `406`, `407`, `408`, `409`, `410`, `411`, `412`, `413`, `414`, `415`, `416`, `417`, `421`, `422`, `423`, `424`, `425`, `426`, `428`, `429`, `431`, `451`
- 5xx 10종: `500`, `501`, `502`, `503`, `504`, `505`, `506`, `507`, `508`, `511`

현재 미사용 상태인 `418`, 폐기된 `510`, 미등록 코드는 목록에서 제외하며 오류 backend에서는 안전한 `404`로 처리합니다. 실제 tenant Ingress가 공통 화면으로 가로채는 범위는 계속 플랫폼 라우팅 `404`와 upstream `500`, `502`, `503`, `504`로 제한합니다.

## 로컬 화면 검증

대시보드를 실행한 뒤 아래 주소를 엽니다.

```text
http://localhost:3000/errors/404
http://localhost:3000/errors/405
http://localhost:3000/errors/409
http://localhost:3000/errors/413
http://localhost:3000/errors/422
http://localhost:3000/errors/500
http://localhost:3000/errors/501
http://localhost:3000/errors/507
http://localhost:3000/errors/511
```

실제 Ingress 오류 backend 응답은 다음 경로로 확인합니다. 이 경로는 화면에 적힌 코드와 동일한 HTTP status를 반환합니다.

```text
http://localhost:3000/api/hosted-error?code=404
http://localhost:3000/api/hosted-error?code=422
http://localhost:3000/api/hosted-error?code=503
http://localhost:3000/api/hosted-error?code=507
```

`/healthz`는 ingress-nginx default backend health 계약을 위해 `200`을 반환합니다.

## Helm 구성

기본값은 호스팅 오류 backend Service와 wildcard fallback Ingress를 만듭니다. `hostedErrors.fallbackIngress.tls.existingSecret`을 비워 두면 `ingress.tls.existingSecret`을 재사용합니다. 최종적으로 선택되는 TLS Secret은 `*.<BASE_DOMAIN>`을 포함해야 하며 production에서는 필수입니다.

```yaml
hostedErrors:
  enabled: true
  statuses: ["500", "502", "503", "504"]
  fallbackIngress:
    enabled: true
    host: "*.raibitserver.app"
    tls:
      existingSecret: raibitserver-wildcard-tls
  traefik:
    enabled: false
```

### ingress-nginx

생성되는 tenant Ingress에는 `nginx.ingress.kubernetes.io/custom-http-errors`가 추가됩니다. ingress-nginx controller의 default backend만 Helm이 만든 Service로 지정합니다. 오류 코드는 Ingress별 annotation이 `500`, `502`, `503`, `504`로 제한하므로 사용자 앱이 직접 반환한 404는 유지됩니다.

```yaml
controller:
  extraArgs:
    default-backend-service: raibitserver-system/raibitserver-hosted-errors
```

Ingress별 `default-backend` annotation은 같은 namespace의 Service만 참조할 수 있으므로, RAIBITSERVER는 controller 전역 backend를 사용합니다. backend가 받은 `X-Code`는 정확한 HTTP status로 다시 반환됩니다.

### Traefik

`hostedErrors.traefik.enabled=true`이면 chart가 `Middleware`를 만들고 Go orchestrator가 tenant Ingress에 신뢰된 middleware reference를 추가합니다. Traefik v3.7.8 이상 CRD가 필요합니다.

공유 middleware는 tenant Ingress와 다른 provider/namespace에 있으므로 Traefik Kubernetes Ingress provider에서 해당 tenant namespace의 cross-provider 참조를 허용해야 합니다. 사용자 워크로드가 임의의 Ingress나 Middleware를 만들 수 없도록 기존 admission/RBAC 경계를 함께 유지합니다.

```yaml
providers:
  kubernetesCRD:
    enabled: true
  kubernetesIngress:
    enabled: true
    crossProviderNamespaces:
      - <tenant-project-namespace>
```

`crossProviderNamespaces`를 생략하면 모든 namespace가 cross-provider 참조를 선언할 수 있습니다. 멀티테넌트 운영에서는 생성된 Ingress가 있는 tenant namespace만 명시적으로 나열하세요.

Middleware는 원 요청의 인증·쿠키 헤더를 오류 backend에 전달하지 않고, `/api/hosted-error?code={status}`만 호출합니다.

## 보안·운영 계약

- 오류 응답은 원본 예외 메시지, 환경 변수, upstream 주소, namespace, Service 이름을 표시하지 않습니다.
- 화면에는 무작위 요청 식별자만 표시하며 운영 로그와 대조할 수 있습니다.
- 5xx 응답은 캐시하지 않고 검색 엔진 색인을 막습니다.
- exact tenant Ingress가 wildcard fallback보다 우선합니다.
- dashboard 세션 쿠키는 host-only이므로 tenant hostname으로 전송되지 않습니다.

컨트롤러별 동작은 [Traefik Errors middleware](https://doc.traefik.io/traefik/v3.7/reference/routing-configuration/http/middlewares/errorpages/)와 [ingress-nginx custom errors](https://kubernetes.github.io/ingress-nginx/user-guide/custom-errors/)의 공식 계약을 따릅니다.
