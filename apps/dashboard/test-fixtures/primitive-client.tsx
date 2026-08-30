"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

function PrimitiveClientFixture() {
  const [commandOpen, setCommandOpen] = useState(false)

  return (
    <section aria-labelledby="interaction-title" className="grid gap-6">
      <div>
        <h2 id="interaction-title" className="text-lg font-medium">상호작용 프리미티브</h2>
        <p className="mt-1 text-sm text-muted-foreground">키보드 포커스, 닫기, 복원을 검증합니다.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>대화상자 열기</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>배포 설정 확인</DialogTitle>
              <DialogDescription>변경 사항을 배포하기 전에 대상 환경을 확인하세요.</DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button>배포하기</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Sheet>
          <SheetTrigger render={<Button variant="outline" />}>시트 열기</SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>프로젝트 세부 정보</SheetTitle>
              <SheetDescription>서비스와 리소스의 현재 상태를 확인합니다.</SheetDescription>
            </SheetHeader>
            <SheetFooter><Button>확인</Button></SheetFooter>
          </SheetContent>
        </Sheet>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>작업 메뉴</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>프로젝트</DropdownMenuLabel>
              <DropdownMenuItem>설정 열기</DropdownMenuItem>
              <DropdownMenuItem>배포 기록 보기</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" onClick={() => setCommandOpen(true)}>명령 팔레트</Button>
        <CommandDialog open={commandOpen} onOpenChange={setCommandOpen} title="프로젝트 명령">
          <Command>
            <CommandInput placeholder="명령 검색" />
            <CommandList>
              <CommandEmpty>일치하는 명령이 없습니다.</CommandEmpty>
              <CommandGroup heading="프로젝트">
                <CommandItem>배포 시작<CommandShortcut>Enter</CommandShortcut></CommandItem>
                <CommandItem>설정 열기<CommandShortcut>S</CommandShortcut></CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </CommandDialog>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" />}>도움말</TooltipTrigger>
            <TooltipContent>최근 배포 상태를 새로 확인합니다.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <Field orientation="horizontal">
        <Checkbox id="notifications" name="notifications" value="enabled" defaultChecked />
        <FieldLabel htmlFor="notifications">배포 완료 알림을 이메일로 받기</FieldLabel>
      </Field>
    </section>
  )
}

export { PrimitiveClientFixture }
