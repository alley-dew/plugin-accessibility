# GitHub 저장소 연결 가이드

이 문서는 로컬 프로젝트를 GitHub 저장소에 연결하는 과정을 정리한 것입니다.

## 작업 순서

### 1. Git 저장소 초기화
```bash
git init
```
- 현재 디렉토리를 Git 저장소로 초기화합니다.
- `.git` 폴더가 생성됩니다.

### 2. .gitignore 파일 생성
프로젝트 루트에 `.gitignore` 파일을 생성하여 불필요한 파일들이 Git에 포함되지 않도록 설정합니다.

**주요 제외 항목:**
- macOS 시스템 파일 (.DS_Store 등)
- Node.js 관련 파일 (node_modules/, *.log 등)
- 빌드 출력물 (dist/, build/ 등)
- IDE 설정 파일 (.vscode/, .idea/ 등)
- 환경 변수 파일 (.env 등)

### 3. 파일 스테이징 (Staging)
```bash
git add .
```
- 모든 변경사항을 스테이징 영역에 추가합니다.
- `.gitignore`에 지정된 파일은 자동으로 제외됩니다.

### 4. 초기 커밋 생성
```bash
git commit -m "Initial commit: Figma Accessibility Checker plugin"
```
- 스테이징된 파일들을 첫 커밋으로 생성합니다.
- 의미 있는 커밋 메시지를 작성합니다.

### 5. 브랜치 이름 설정 (선택사항)
```bash
git branch -M main
```
- 기본 브랜치 이름을 `main`으로 설정합니다.
- GitHub의 기본 브랜치 이름과 일치시킵니다.

### 6. GitHub에서 새 저장소 생성
1. https://github.com/new 접속
2. 저장소 이름 입력 (예: `plugin-accessibility`)
3. Public 또는 Private 선택
4. **"Initialize this repository with a README" 체크 해제** (이미 커밋이 있는 경우)
5. "Create repository" 클릭

### 7. 원격 저장소 연결
```bash
git remote add origin https://github.com/사용자명/저장소명.git
```
- 원격 저장소를 `origin`이라는 이름으로 추가합니다.
- 예시: `git remote add origin https://github.com/alley-dew/plugin-accessibility.git`

**원격 저장소 확인:**
```bash
git remote -v
```

### 8. 원격 저장소와 동기화 (충돌이 있는 경우)

#### 8-1. 원격 저장소 내용 가져오기
```bash
git pull origin main --allow-unrelated-histories --no-rebase
```
- 원격 저장소에 이미 내용이 있는 경우 충돌을 해결하기 위해 먼저 가져옵니다.
- `--allow-unrelated-histories`: 관련 없는 이력 병합 허용
- `--no-rebase`: 병합 전략 사용

#### 8-2. 충돌 해결
충돌이 발생한 파일을 열어서 수동으로 해결합니다:
- `<<<<<<< HEAD` ~ `=======` 사이: 로컬 버전
- `=======` ~ `>>>>>>> 커밋해시` 사이: 원격 버전

**충돌 해결 후:**
```bash
git add .gitignore README.md  # 충돌 해결된 파일들
git commit -m "Merge remote repository: resolve conflicts in .gitignore and README.md"
```

### 9. GitHub에 푸시
```bash
git push -u origin main
```
- `-u` 옵션: upstream 설정 (다음부터는 `git push`만으로도 가능)
- 로컬 `main` 브랜치를 원격 `origin/main`에 푸시합니다.

## 이후 작업 흐름

### 일반적인 작업 흐름
```bash
# 1. 변경사항 확인
git status

# 2. 변경사항 스테이징
git add .

# 3. 커밋 생성
git commit -m "커밋 메시지"

# 4. GitHub에 푸시
git push
```

### 특정 파일만 커밋하기
```bash
git add 파일명1 파일명2
git commit -m "커밋 메시지"
git push
```

### 원격 저장소의 최신 변경사항 가져오기
```bash
git pull
```

## 참고사항

### Git 사용자 정보 설정 (선택사항)
```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### 원격 저장소 URL 변경
```bash
git remote set-url origin https://github.com/새사용자명/새저장소명.git
```

### 원격 저장소 확인
```bash
git remote -v
```

### 원격 저장소 제거
```bash
git remote remove origin
```

## 완료된 작업 요약

✅ Git 저장소 초기화
✅ .gitignore 파일 생성 및 설정
✅ 초기 커밋 생성
✅ GitHub 원격 저장소 연결
✅ 충돌 해결 (`.gitignore`, `README.md`)
✅ 코드 푸시 완료

**저장소 주소:** https://github.com/alley-dew/plugin-accessibility

