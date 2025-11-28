#!/bin/bash

# MD 파일 업데이트 및 히스토리 기록 스크립트
# Git hook에서 호출됨

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HISTORY_FILE="$SCRIPT_DIR/history.md"
README_FILE="$SCRIPT_DIR/README.md"
PRD_FILE="$SCRIPT_DIR/prd.md"

# Git 정보 가져오기 (가장 최근 커밋 - post-commit hook에서 실행되므로 정확한 정보 가져올 수 있음)
COMMIT_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "Initial commit")
COMMIT_HASH=$(git log -1 --pretty=%h 2>/dev/null || echo "N/A")
COMMIT_DATE=$(git log -1 --pretty=%ai 2>/dev/null | cut -d' ' -f1 || date +%Y-%m-%d)
COMMIT_AUTHOR=$(git log -1 --pretty=%an 2>/dev/null || git config user.name || echo "Unknown")

# 변경된 파일 목록 가져오기 (이전 커밋과 비교)
if git rev-parse HEAD~1 >/dev/null 2>&1; then
    CHANGED_FILES=$(git diff HEAD~1 HEAD --name-only --diff-filter=ACM 2>/dev/null | grep -v "^history.md$" | grep -v "^\.git")
else
    # 첫 커밋인 경우
    CHANGED_FILES=$(git ls-tree -r HEAD --name-only 2>/dev/null | grep -v "^history.md$" | grep -v "^\.git")
fi

# 변경된 파일이 없으면 빈 문자열
if [ -z "$CHANGED_FILES" ]; then
    CHANGED_FILES="(변경된 파일 없음)"
fi

# 히스토리 항목 생성
HISTORY_ENTRY="## $COMMIT_DATE - $COMMIT_HASH

**커밋 메시지:** $COMMIT_MSG  
**작성자:** $COMMIT_AUTHOR  
**변경된 파일:**
$(echo "$CHANGED_FILES" | while IFS= read -r line; do echo "- $line"; done)

---

"

# 히스토리 파일에 추가 (파일 상단에)
if [ -f "$HISTORY_FILE" ]; then
    # 기존 내용을 임시 파일에 저장
    TEMP_FILE=$(mktemp)
    echo "$HISTORY_ENTRY" > "$TEMP_FILE"
    cat "$HISTORY_FILE" >> "$TEMP_FILE"
    mv "$TEMP_FILE" "$HISTORY_FILE"
else
    # 히스토리 파일이 없으면 생성
    cat > "$HISTORY_FILE" << EOF
# 업데이트 히스토리

이 파일은 프로젝트의 변경 이력을 자동으로 기록합니다.

$HISTORY_ENTRY
EOF
fi

# README.md의 마지막 업데이트 날짜 업데이트 (있는 경우)
if [ -f "$README_FILE" ]; then
    # "최종 업데이트" 또는 "Last updated" 같은 패턴 찾아서 업데이트
    if grep -q "최종 업데이트\|Last updated\|Last update" "$README_FILE"; then
        sed -i.bak "s/최종 업데이트:.*/최종 업데이트: $COMMIT_DATE/" "$README_FILE" 2>/dev/null || \
        sed -i.bak "s/Last updated:.*/Last updated: $COMMIT_DATE/" "$README_FILE" 2>/dev/null || \
        sed -i.bak "s/Last update:.*/Last update: $COMMIT_DATE/" "$README_FILE" 2>/dev/null
        rm -f "$README_FILE.bak" 2>/dev/null
    fi
fi

# PRD.md의 버전 정보 업데이트 (있는 경우)
if [ -f "$PRD_FILE" ]; then
    # 버전 정보 섹션 찾아서 업데이트
    if grep -q "최종 업데이트\|Last updated" "$PRD_FILE"; then
        sed -i.bak "s/최종 업데이트:.*/최종 업데이트: $COMMIT_DATE/" "$PRD_FILE" 2>/dev/null || \
        sed -i.bak "s/Last updated:.*/Last updated: $COMMIT_DATE/" "$PRD_FILE" 2>/dev/null
        rm -f "$PRD_FILE.bak" 2>/dev/null
    fi
fi

echo "✅ 문서 업데이트 완료: history.md에 히스토리 기록됨"

