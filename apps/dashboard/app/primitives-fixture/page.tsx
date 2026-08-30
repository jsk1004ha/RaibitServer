import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ActionLink, Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { PrimitiveClientFixture } from "@/test-fixtures/primitive-client"
import { assertE2eFixturesEnabled } from "../errors/fixtures/fixture-access"

export const dynamic = "force-dynamic"

export default function PrimitiveFixturePage() {
  assertE2eFixturesEnabled()

  return (
    <main className="min-h-dvh bg-background px-4 py-10 text-foreground sm:px-8">
      <div className="mx-auto grid w-full max-w-5xl gap-10">
        <header className="grid gap-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink href="/?mode=fixture">RAIBIT SERVER</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>프리미티브</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex flex-wrap items-center gap-3">
            <Badge>RAIBIT NAVY</Badge>
            <Badge variant="secondary">LIGHT SYSTEM</Badge>
          </div>
          <h1 className="max-w-3xl text-4xl font-medium tracking-[-0.72px] break-keep sm:text-5xl">
            긴 한국어 서비스 이름도 자연스럽고 안정적으로 읽히는 운영 인터페이스
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground break-keep">
            흰색 캔버스와 라이빗 네이비를 중심으로 기본, 포커스, 오류, 비활성 상태를 확인합니다.
          </p>
        </header>

        <section aria-labelledby="button-title" className="grid gap-4">
          <h2 id="button-title" className="text-lg font-medium">행동</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button>프로젝트 만들기</Button>
            <Button variant="outline">설정 보기</Button>
            <Button disabled>비활성</Button>
            <Button disabled><Spinner data-icon="inline-start" />처리 중</Button>
            <ActionLink href="/?notice=saved">쿼리를 유지하는 작업 링크</ActionLink>
          </div>
        </section>

        <Separator />

        <section aria-labelledby="feedback-title" className="grid gap-4">
          <h2 id="feedback-title" className="text-lg font-medium">피드백</h2>
          <Alert variant="notice"><AlertTitle>저장 완료</AlertTitle><AlertDescription>변경 사항을 저장했습니다.</AlertDescription></Alert>
          <Alert variant="destructive"><AlertTitle>배포 실패</AlertTitle><AlertDescription>입력 내용을 확인한 뒤 다시 시도하세요.</AlertDescription></Alert>
          <Progress value={64}><ProgressLabel>배포 준비</ProgressLabel><ProgressValue /></Progress>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>네이티브 폼 직렬화</CardTitle>
            <CardDescription>이름과 값은 브라우저 FormData 규칙을 그대로 따릅니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <form id="primitive-form" className="grid gap-5">
              <FieldGroup>
                <Field><FieldLabel htmlFor="project-name">프로젝트 이름</FieldLabel><Input id="project-name" name="projectName" defaultValue="raibit-console" /></Field>
                <Field><FieldLabel htmlFor="description">설명</FieldLabel><Textarea id="description" name="description" defaultValue="안전한 배포 환경" /></Field>
                <Field><FieldLabel htmlFor="region">리전</FieldLabel><Select id="region" name="region" defaultValue="icn"><option value="icn">서울</option><option value="nrt">도쿄</option></Select><FieldDescription>가장 가까운 리전을 선택하세요.</FieldDescription></Field>
                <Field data-invalid><FieldLabel htmlFor="invalid-name">오류 상태</FieldLabel><Input id="invalid-name" name="invalidName" aria-invalid defaultValue="" /><FieldError>필수 입력 항목입니다.</FieldError></Field>
              </FieldGroup>
              <PrimitiveClientFixture />
            </form>
          </CardContent>
        </Card>

        <section aria-labelledby="data-title" className="grid gap-4">
          <h2 id="data-title" className="text-lg font-medium">데이터와 빈 상태</h2>
          <Table>
            <TableHeader><TableRow><TableHead>서비스</TableHead><TableHead>상태</TableHead></TableRow></TableHeader>
            <TableBody><TableRow><TableCell>web</TableCell><TableCell><Badge variant="outline">실행 중</Badge></TableCell></TableRow></TableBody>
          </Table>
          <div className="grid gap-4 sm:grid-cols-2">
            <Empty className="border"><EmptyHeader><EmptyTitle>아직 배포가 없습니다</EmptyTitle><EmptyDescription>첫 배포를 시작하면 기록이 여기에 표시됩니다.</EmptyDescription></EmptyHeader><EmptyContent><Button size="sm">배포 시작</Button></EmptyContent></Empty>
            <div className="grid content-start gap-3 rounded-lg border border-border p-6" aria-label="로딩 상태" role="status"><Skeleton className="h-5 w-32" /><Skeleton className="h-20 w-full" /></div>
          </div>
        </section>
      </div>
    </main>
  )
}
