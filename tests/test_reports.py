import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import app as project


class ReportRouteTests(unittest.TestCase):
    def setUp(self):
        for name in (
            "DATABASE_URL",
            "ADMIN_PASSWORD",
        ):
            self.addCleanup(setattr, project, name, getattr(project, name))
        self.addCleanup(
            project.app.config.update,
            TESTING=project.app.config["TESTING"],
            SECRET_KEY=project.app.config["SECRET_KEY"],
        )
        project.app.config.update(TESTING=True, SECRET_KEY="test-secret")
        self.client = project.app.test_client()
        self.image = {
            "filename": "sample.png",
            "url": "https://images.example/sample.png",
            "storage_id": "sample-id__sample.png",
        }
        self.report = {
            "id": 12,
            "image_id": self.image["storage_id"],
            "image_filename": self.image["filename"],
            "image_url": self.image["url"],
            "reason": "A test report",
            "status": "open",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        project.DATABASE_URL = "postgresql://test"
        project.ADMIN_PASSWORD = "test-admin-password"

    def test_report_is_saved_for_admin_review_without_email_configuration(self):
        with (
            patch.object(project, "_list_image_entries", return_value=[self.image]),
            patch.object(project, "_consume_report_rate_limit", return_value=True),
            patch.object(project, "_insert_report", return_value=self.report) as insert_report,
        ):
            response = self.client.post(
                "/report",
                json={"image_id": self.image["storage_id"], "reason": "A test report"},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json(), {"success": True})
        insert_report.assert_called_once_with(self.image, "A test report")

    def test_unknown_image_is_rejected_without_saving(self):
        with (
            patch.object(project, "_list_image_entries", return_value=[self.image]),
            patch.object(project, "_insert_report") as insert_report,
        ):
            response = self.client.post(
                "/report",
                json={"image_id": "not-an-image", "reason": "A test report"},
            )

        self.assertEqual(response.status_code, 404)
        insert_report.assert_not_called()

    def test_rate_limit_blocks_report_before_saving(self):
        with (
            patch.object(project, "_list_image_entries", return_value=[self.image]),
            patch.object(project, "_consume_report_rate_limit", return_value=False),
            patch.object(project, "_insert_report") as insert_report,
        ):
            response = self.client.post(
                "/report",
                json={"image_id": self.image["storage_id"], "reason": "A test report"},
            )

        self.assertEqual(response.status_code, 429)
        insert_report.assert_not_called()

    def test_comment_is_saved_without_an_account_and_enforces_length_limit(self):
        comment = {
            "id": 8,
            "image_id": self.image["storage_id"],
            "author": "Alex",
            "content": "Nice image",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with (
            patch.object(project, "_list_image_entries", return_value=[self.image]),
            patch.object(project, "_insert_comment", return_value=comment) as insert_comment,
        ):
            response = self.client.post(
                "/comments",
                json={
                    "image_id": self.image["storage_id"],
                    "author": " Alex ",
                    "content": " Nice image ",
                },
            )
            too_long = self.client.post(
                "/comments",
                json={
                    "image_id": self.image["storage_id"],
                    "author": "Alex",
                    "content": "x" * (project.MAX_COMMENT_LENGTH + 1),
                },
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["comment"]["id"], comment["id"])
        insert_comment.assert_called_once_with(self.image, "Alex", "Nice image")
        self.assertEqual(too_long.status_code, 400)

    def test_comment_report_is_rate_limited_and_saved_for_admin(self):
        with (
            patch.object(project, "_report_client_ip", return_value="192.0.2.1"),
            patch.object(project, "_consume_report_rate_limit", return_value=True),
            patch.object(project, "_insert_comment_report", return_value=True) as insert_report,
        ):
            response = self.client.post(
                "/comments/8/report",
                json={"reason": "This comment is abusive"},
            )

        self.assertEqual(response.status_code, 201)
        insert_report.assert_called_once_with(8, "This comment is abusive")

    def test_admin_can_delete_comment_with_csrf(self):
        with self.client.session_transaction() as admin_session:
            admin_session["admin_authenticated"] = True
            admin_session["csrf_token"] = "valid-token"

        self.assertEqual(self.client.delete("/admin/comments/8").status_code, 403)
        with patch.object(project, "_delete_comment", return_value=True) as delete_comment:
            response = self.client.delete(
                "/admin/comments/8",
                headers={"X-CSRF-Token": "valid-token"},
            )

        self.assertEqual(response.status_code, 200)
        delete_comment.assert_called_once_with(8)

    def test_admin_can_view_and_review_reports_with_csrf(self):
        with patch.object(project, "_list_reports", return_value=[self.report]):
            self.assertEqual(self.client.get("/admin/reports").status_code, 401)
            with self.client.session_transaction() as admin_session:
                admin_session["admin_authenticated"] = True
                admin_session["csrf_token"] = "valid-token"

            response = self.client.get("/admin/reports")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["reports"][0]["id"], self.report["id"])
            self.assertEqual(response.headers["Cache-Control"], "no-store")

            self.assertEqual(
                self.client.post(f"/admin/reports/{self.report['id']}/review").status_code,
                403,
            )
            with patch.object(project, "_update_report_fields", return_value=True) as update:
                reviewed = self.client.post(
                    f"/admin/reports/{self.report['id']}/review",
                    headers={"X-CSRF-Token": "valid-token"},
                )

        self.assertEqual(reviewed.status_code, 200)
        update.assert_called_once_with(self.report["id"], status="reviewed")

if __name__ == "__main__":
    unittest.main()
