import hashlib
import hmac
import unittest
from unittest.mock import patch

import app as project


class LikeRouteTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, project, "DATABASE_URL", project.DATABASE_URL)
        self.addCleanup(
            project.app.config.update,
            TESTING=project.app.config["TESTING"],
            SECRET_KEY=project.app.config["SECRET_KEY"],
        )
        project.app.config.update(TESTING=True, SECRET_KEY="test-secret")
        project.DATABASE_URL = "postgresql://test"
        self.client = project.app.test_client()
        self.image = {
            "filename": "sample.png",
            "url": "https://images.example/sample.png",
            "storage_id": "sample-id__sample.png",
        }

    def test_like_ip_hash_uses_a_keyed_hash(self):
        with patch.object(project, "_report_client_ip", return_value="192.0.2.1"):
            result = project._like_ip_hash()

        expected = hmac.new(
            b"test-secret",
            b"likes:192.0.2.1",
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(result, expected)
        self.assertNotEqual(result, "192.0.2.1")

    def test_like_icons_are_served(self):
        for filename in ("LikeIcon1.png", "LikeIcon2.png"):
            with self.subTest(filename=filename):
                response = self.client.get(f"/Icons/{filename}")

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, "image/png")
                response.close()

    def test_like_state_is_public_and_includes_viewer_state(self):
        states = [
            {
                "target_type": "image",
                "target_id": self.image["storage_id"],
                "count": 3,
                "liked": True,
            }
        ]
        with (
            patch.object(project, "_like_ip_hash", return_value="hashed-ip"),
            patch.object(project, "_list_like_states", return_value=states) as load_likes,
        ):
            response = self.client.post(
                "/likes/state",
                json={"image_ids": [self.image["storage_id"]]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["likes"], states)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        load_likes.assert_called_once_with([self.image["storage_id"]], "hashed-ip")

    def test_like_image_adds_a_vote(self):
        with (
            patch.object(project, "_list_image_entries", return_value=[self.image]),
            patch.object(project, "_like_ip_hash", return_value="hashed-ip"),
            patch.object(project, "_change_like", return_value=2) as change_like,
        ):
            response = self.client.post(
                "/likes",
                json={
                    "target_type": "image",
                    "target_id": self.image["storage_id"],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["count"], 2)
        self.assertTrue(response.get_json()["liked"])
        change_like.assert_called_once_with(
            "image",
            self.image["storage_id"],
            "hashed-ip",
            True,
        )

    def test_unlike_comment_removes_a_vote(self):
        with (
            patch.object(project, "_like_ip_hash", return_value="hashed-ip"),
            patch.object(project, "_change_like", return_value=1) as change_like,
        ):
            response = self.client.delete(
                "/likes",
                json={"target_type": "comment", "target_id": "008"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["target_id"], "8")
        self.assertFalse(response.get_json()["liked"])
        change_like.assert_called_once_with("comment", "8", "hashed-ip", False)

    def test_like_requires_secret_key(self):
        project.app.config["SECRET_KEY"] = None
        with patch.object(project, "_list_image_entries", return_value=[self.image]):
            response = self.client.post(
                "/likes",
                json={
                    "target_type": "image",
                    "target_id": self.image["storage_id"],
                },
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("try again later", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
