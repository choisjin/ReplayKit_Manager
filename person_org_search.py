# -*- coding: utf-8 -*-
"""
Jira 유저 검색 모듈 (Python 3.10 기준)

기능:
  1. 키워드(이름/아이디/이메일/조직명)로 Jira 사용자 검색
  2. 프로젝트 할당 가능 사용자 전체 로드 → 팀 목록 리스트업
  3. 팀 콤보박스 필터로 간추린 뒤 선택 → 이름/직급/팀 반환

displayName 형식 가정:
    "최세진/(협력사) 선임연구원/VS TC설계/검증자동화팀(sejin3569.choi)"
    → 이름 / 직급 / 조직... 순. 세 번째 이후를 합쳐 팀으로 취급하고
      '(' 앞까지만 사용 (뒤의 계정 ID 표기는 제거).

다른 프로젝트에서 사용 예:
    from jira import JIRA
    from person_org_search import select_user_dialog

    jira = JIRA(server="http://vlm.lge.com/issue", basic_auth=(user_id, password))

    user = select_user_dialog(jira, parent=self)   # 검색/필터 다이얼로그
    if user:
        print(user["name"], user["title"], user["team"])
"""


def parse_display_name(display_name: str) -> dict:
    """
    displayName을 이름/직급/팀으로 분해합니다.

    예: "최세진/(협력사) 선임연구원/VS TC설계/검증자동화팀(sejin3569.choi)"
    반환: {"name": "최세진", "title": "(협력사) 선임연구원",
           "team": "VS TC설계/검증자동화팀"}
    직급/팀 정보가 없으면 해당 값은 빈 문자열.
    """
    result = {"name": "", "title": "", "team": ""}
    if not display_name:
        return result

    parts = [p.strip() for p in display_name.split("/")]

    result["name"] = parts[0]
    if len(parts) >= 2:
        result["title"] = parts[1]
    if len(parts) >= 3:
        # 세 번째 이후를 합쳐 팀으로 취급, '(' 뒤의 계정 ID 표기는 제거
        team = "/".join(parts[2:])
        result["team"] = team.split("(")[0].strip()

    return result


def search_users(jira, keyword: str, max_results: int | None = None) -> list[dict]:
    """
    키워드로 Jira 사용자를 검색합니다.
    displayName에 조직명이 포함되므로 팀명(예: "검증자동화팀")으로도 검색 가능합니다.

    max_results가 None이면 제한 없이 전체를 가져옵니다.
    이름(displayName)이 없는 계정은 결과에서 제외합니다.

    반환: 사용자별 {"name", "title", "team", "display_name", "user_id"} dict 리스트
    """
    if not keyword or not keyword.strip():
        return []

    # maxResults=False → 페이지 단위로 전체 조회 (jira 라이브러리 동작)
    users = jira.search_users(keyword.strip(), maxResults=max_results or False)

    results = []
    for user in users:
        display_name = getattr(user, "displayName", "") or ""
        info = parse_display_name(display_name)
        if not info["name"]:  # 이름 없는 계정 제외
            continue
        info["display_name"] = display_name
        info["user_id"] = getattr(user, "name", "") or ""  # Jira Server 계정 ID
        results.append(info)
    return results


def fetch_group_users(jira, group_name: str = "jira-users") -> list[dict]:
    """
    그룹 멤버 전체를 한 번에 불러옵니다. (전체 조직/팀 리스트업 용도)
    주의: 그룹 조회 API는 Jira 관리자 권한이 필요합니다 (일반 계정은 HTTP 403).
    일반 계정은 fetch_project_users를 사용하세요.

    반환 형식은 search_users와 동일.
    """
    members = jira.group_members(group_name)  # {username: {"fullname", "email", "active"}}

    results = []
    for username, data in members.items():
        display_name = data.get("fullname", "") or ""
        info = parse_display_name(display_name)
        info["display_name"] = display_name
        info["user_id"] = username
        results.append(info)
    return results


def _users_from_assignable_api(jira, project_key: str, batch: int = 1000,
                               max_users: int = 10000) -> list[dict]:
    """
    user/assignable/search 엔드포인트를 username 파라미터 없이 직접 호출해
    프로젝트에 할당 가능한 사용자 전체를 페이지 단위로 가져옵니다.
    (jira 라이브러리 메서드는 username을 강제하므로 REST를 직접 호출)
    """
    raw = []
    start = 0
    while start < max_users:
        page = jira._get_json(
            "user/assignable/search",
            params={"project": project_key, "startAt": start, "maxResults": batch})
        if not page:
            break
        raw.extend(page)
        if len(page) < batch:
            break
        start += len(page)
    return raw


def _users_from_issues(jira, project_key: str, max_issues: int = 500) -> list[dict]:
    """프로젝트 이슈의 Reporter/Assignee를 모아 사용자 목록을 만듭니다. (폴백)"""
    issues = jira.search_issues(
        f"project = {project_key}", maxResults=max_issues, fields="reporter,assignee")
    raw = []
    for issue in issues:
        for user in (getattr(issue.fields, "reporter", None),
                     getattr(issue.fields, "assignee", None)):
            if user:
                raw.append({
                    "displayName": getattr(user, "displayName", "") or "",
                    "name": getattr(user, "name", "") or "",
                })
    return raw


def fetch_project_users(jira, project_key: str = "REAVN", batch: int = 1000) -> list[dict]:
    """
    프로젝트 사용자 전체를 불러옵니다. (전체 조직/팀 리스트업 용도)
    일반 계정 권한으로 호출 가능합니다.

    1차: 할당 가능 사용자 API → 결과가 없으면
    2차: 프로젝트 이슈의 Reporter/Assignee 수집으로 폴백.

    반환 형식은 search_users와 동일.
    """
    try:
        raw = _users_from_assignable_api(jira, project_key, batch)
    except Exception:
        raw = []
    if not raw:
        raw = _users_from_issues(jira, project_key)

    results = []
    seen = set()
    for user in raw:
        user_id = user.get("name") or user.get("key") or ""
        display_name = user.get("displayName") or ""
        dedup_key = user_id or display_name
        if not dedup_key or dedup_key in seen:
            continue
        seen.add(dedup_key)
        info = parse_display_name(display_name)
        if not info["name"]:  # 이름 없는 계정 제외
            continue
        info["display_name"] = display_name
        info["user_id"] = user_id
        results.append(info)
    return results


def list_teams(users: list[dict]) -> list[str]:
    """유저 목록에서 팀 목록을 중복 없이 정렬해 반환합니다."""
    return sorted({u.get("team", "") for u in users if u.get("team")})


def filter_users(users: list[dict], team: str = "") -> list[dict]:
    """팀으로 유저 목록을 필터링합니다. 빈 문자열은 '전체'로 취급."""
    if not team:
        return users
    return [u for u in users if u.get("team") == team]


def select_user_dialog(jira, parent=None, project_key: str = "REAVN") -> dict | None:
    """
    유저 검색/필터 다이얼로그를 띄우고, 선택된 사용자 정보를 반환합니다.

    - 검색어 입력 → 키워드 검색 (이름/아이디/조직명)
    - [전체 로드] → 프로젝트 할당 가능 사용자 전체를 불러와 팀 목록 리스트업
    - 팀 콤보박스로 결과를 간추린 뒤 행 선택(더블클릭 또는 OK)

    반환: {"name", "title", "team", "display_name", "user_id"}
          취소 시 None
    """
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import (
        QApplication, QComboBox, QDialog, QDialogButtonBox, QHBoxLayout,
        QLabel, QLineEdit, QMessageBox, QPushButton, QTableWidget,
        QTableWidgetItem, QVBoxLayout,
    )

    ALL = "전체"

    class UserSearchDialog(QDialog):
        HEADERS = ["이름", "직급", "팀", "ID"]

        def __init__(self, jira, parent=None):
            super().__init__(parent)
            self.jira = jira
            self.all_results: list[dict] = []       # 검색/로드된 전체 유저
            self.filtered_results: list[dict] = []  # 필터 적용 후 유저
            self.selected_user: dict | None = None

            self.setWindowTitle("유저 검색")
            self.resize(640, 480)

            layout = QVBoxLayout(self)

            # 1행: 검색어 입력 + 검색 + 전체 로드
            search_layout = QHBoxLayout()
            self.search_edit = QLineEdit(self)
            self.search_edit.setPlaceholderText("이름 / 아이디 / 조직명 입력 후 Enter")
            self.search_edit.returnPressed.connect(self.do_search)
            search_button = QPushButton("검색", self)
            search_button.clicked.connect(self.do_search)
            load_all_button = QPushButton("전체 로드", self)
            load_all_button.setToolTip(
                f'프로젝트 "{project_key}"에 할당 가능한 사용자 전체를 불러와 '
                "팀 목록을 만듭니다.")
            load_all_button.clicked.connect(self.load_all)
            search_layout.addWidget(self.search_edit)
            search_layout.addWidget(search_button)
            search_layout.addWidget(load_all_button)
            layout.addLayout(search_layout)

            # 2행: 팀 필터 콤보박스
            filter_layout = QHBoxLayout()
            filter_layout.addWidget(QLabel("팀:", self))
            self.team_combo = QComboBox(self)
            self.team_combo.currentTextChanged.connect(self.apply_filter)
            filter_layout.addWidget(self.team_combo, stretch=1)
            reset_button = QPushButton("필터 초기화", self)
            reset_button.clicked.connect(self.reset_filter)
            filter_layout.addWidget(reset_button)
            layout.addLayout(filter_layout)

            # 결과 테이블
            self.table = QTableWidget(0, len(self.HEADERS), self)
            self.table.setHorizontalHeaderLabels(self.HEADERS)
            self.table.setSelectionBehavior(QTableWidget.SelectRows)
            self.table.setSelectionMode(QTableWidget.SingleSelection)
            self.table.setEditTriggers(QTableWidget.NoEditTriggers)
            self.table.doubleClicked.connect(self.accept_selection)
            layout.addWidget(self.table)

            # 상태 표시 + OK/Cancel
            self.status_label = QLabel("", self)
            layout.addWidget(self.status_label)
            buttons = QDialogButtonBox(
                QDialogButtonBox.Ok | QDialogButtonBox.Cancel, self)
            buttons.accepted.connect(self.accept_selection)
            buttons.rejected.connect(self.reject)
            layout.addWidget(buttons)

        # --- 데이터 로드 ---

        def do_search(self):
            keyword = self.search_edit.text().strip()
            if not keyword:
                QMessageBox.warning(self, "검색어 없음", "검색어를 입력해주세요.")
                return
            try:
                results = search_users(self.jira, keyword)
            except Exception as e:
                QMessageBox.critical(self, "검색 실패", f"유저 검색 중 오류 발생:\n{e}")
                return
            if not results:
                QMessageBox.information(self, "검색 결과 없음",
                                        f'"{keyword}"에 해당하는 사용자가 없습니다.')
                return
            self.set_results(results)

        def load_all(self):
            QApplication.setOverrideCursor(Qt.WaitCursor)
            try:
                results = fetch_project_users(self.jira, project_key)
            except Exception as e:
                QMessageBox.critical(
                    self, "로드 실패",
                    f'프로젝트 "{project_key}" 사용자를 불러오지 못했습니다:\n{e}')
                return
            finally:
                QApplication.restoreOverrideCursor()
            if not results:
                QMessageBox.information(
                    self, "결과 없음",
                    f'프로젝트 "{project_key}"에서 사용자를 찾지 못했습니다.')
                return
            self.set_results(results)

        def set_results(self, results: list[dict]):
            """새 유저 목록을 반영하고 팀 콤보박스를 다시 구성합니다."""
            self.all_results = results

            self.team_combo.blockSignals(True)
            self.team_combo.clear()
            self.team_combo.addItem(ALL)
            self.team_combo.addItems(list_teams(results))
            self.team_combo.blockSignals(False)

            self.apply_filter()

        # --- 필터링 ---

        def reset_filter(self):
            self.team_combo.setCurrentText(ALL)

        def apply_filter(self, _text=None):
            team = self.team_combo.currentText()
            self.filtered_results = filter_users(
                self.all_results,
                team="" if team == ALL else team,
            )
            self.update_table()

        def update_table(self):
            self.table.setRowCount(0)
            for row, info in enumerate(self.filtered_results):
                self.table.insertRow(row)
                values = [info["name"], info["title"], info["team"],
                          info["user_id"]]
                for col, value in enumerate(values):
                    self.table.setItem(row, col, QTableWidgetItem(value))
            self.table.resizeColumnsToContents()
            self.status_label.setText(
                f"{len(self.filtered_results)}명 표시 (전체 {len(self.all_results)}명)")

        # --- 선택 ---

        def accept_selection(self):
            row = self.table.currentRow()
            if row < 0 or row >= len(self.filtered_results):
                QMessageBox.warning(self, "선택 없음", "사용자를 선택해주세요.")
                return
            self.selected_user = self.filtered_results[row]
            self.accept()

    dialog = UserSearchDialog(jira, parent)
    if dialog.exec() == QDialog.Accepted:
        return dialog.selected_user
    return None


def main():
    """단독 실행: 로그인 다이얼로그 → 유저 검색 다이얼로그 → 선택 결과 표시."""
    import sys

    from jira import JIRA
    from PySide6.QtWidgets import (
        QApplication, QDialog, QDialogButtonBox, QFormLayout,
        QLineEdit, QMessageBox,
    )

    app = QApplication(sys.argv)

    class LoginDialog(QDialog):
        def __init__(self):
            super().__init__()
            self.jira = None
            self.setWindowTitle("Jira 로그인")
            layout = QFormLayout(self)
            self.server_edit = QLineEdit("http://vlm.lge.com/issue", self)
            self.id_edit = QLineEdit(self)
            self.pw_edit = QLineEdit(self)
            self.pw_edit.setEchoMode(QLineEdit.Password)
            layout.addRow("서버:", self.server_edit)
            layout.addRow("Jira ID:", self.id_edit)
            layout.addRow("비밀번호:", self.pw_edit)
            buttons = QDialogButtonBox(
                QDialogButtonBox.Ok | QDialogButtonBox.Cancel, self)
            buttons.accepted.connect(self.try_login)
            buttons.rejected.connect(self.reject)
            layout.addRow(buttons)

        def try_login(self):
            if not self.id_edit.text().strip() or not self.pw_edit.text():
                QMessageBox.warning(self, "입력 필요", "Jira ID와 비밀번호를 입력해주세요.")
                return
            try:
                self.jira = JIRA(
                    server=self.server_edit.text().strip(),
                    basic_auth=(self.id_edit.text().strip(), self.pw_edit.text()),
                    timeout=15, max_retries=0,
                )
                self.jira.myself()  # 인증 확인 (실패 시 예외)
            except Exception as e:
                self.jira = None
                QMessageBox.critical(self, "로그인 실패", f"Jira 접속에 실패했습니다:\n{e}")
                return
            self.accept()

    login = LoginDialog()
    if login.exec() != QDialog.Accepted:
        return

    user = select_user_dialog(login.jira)
    if user:
        QMessageBox.information(
            None, "선택 결과",
            f"이름: {user['name']}\n직급: {user['title']}\n"
            f"팀: {user['team']}\nID: {user['user_id']}")


if __name__ == "__main__":
    main()
