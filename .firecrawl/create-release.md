[Skip to main content](https://docs.github.com/en/rest/releases/releases#main-content)

[Skip to content](https://docs.github.com/en/rest/releases/releases#main-content)

Collapse sidebar

Expand sidebar

In this article

The REST API is now versioned.For more information, see " [About API versioning](https://docs.github.com/rest/overview/api-versions)."

# REST API endpoints for releases

Use the REST API to create, modify, and delete releases.

Note

These endpoints replace the endpoints to manage downloads. You can retrieve the download count and browser download URL from these endpoints.

## [List releases](https://docs.github.com/en/rest/releases/releases\#list-releases)

This returns a list of releases, which does not include regular Git tags that have not been associated with a release. To get a list of Git tags, use the [Repository Tags API](https://docs.github.com/rest/repos/repos#list-repository-tags).

Information about published releases are available to everyone. Only users with push access will receive listings for draft releases.

### [Fine-grained access tokens for "List releases"](https://docs.github.com/en/rest/releases/releases\#list-releases--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have the following permission set:

- "Contents" repository permissions (read)

This endpoint can be used without authentication or the aforementioned permissions if only public resources are requested.

### [Parameters for "List releases"](https://docs.github.com/en/rest/releases/releases\#list-releases--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |

Path parameters

| Name, Type, Description |
| --- |
| `per_page`integer<br>The number of results per page (max 100). For more information, see " [Using pagination in the REST API](https://docs.github.com/rest/using-the-rest-api/using-pagination-in-the-rest-api)."<br>Default: `30` |
| `page`integer<br>The page number of the results to fetch. For more information, see " [Using pagination in the REST API](https://docs.github.com/rest/using-the-rest-api/using-pagination-in-the-rest-api)."<br>Default: `1` |

Query parameters

### [HTTP response status codes for "List releases"](https://docs.github.com/en/rest/releases/releases\#list-releases--status-codes)

| Status code | Description |
| --- | --- |
| `200` | OK |
| `404` | Resource not found |

### [Code samples for "List releases"](https://docs.github.com/en/rest/releases/releases\#list-releases--code-samples)

#### Request example

get/repos/{owner}/{repo}/releases

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases`

#### Response

- Example response

- Response schema


`Status: 200`

`[\
{\
    "url": "https://api.github.com/repos/octocat/Hello-World/releases/1",\
    "html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0",\
    "assets_url": "https://api.github.com/repos/octocat/Hello-World/releases/1/assets",\
    "upload_url": "https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}",\
    "tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",\
    "zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",\
    "id": 1,\
    "node_id": "MDc6UmVsZWFzZTE=",\
    "tag_name": "v1.0.0",\
    "target_commitish": "master",\
    "name": "v1.0.0",\
    "body": "Description of the release",\
    "draft": false,\
    "prerelease": false,\
    "immutable": false,\
    "created_at": "2013-02-27T19:35:32Z",\
    "published_at": "2013-02-27T19:35:32Z",\
    "author": {\
      "login": "octocat",\
      "id": 1,\
      "node_id": "MDQ6VXNlcjE=",\
      "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
      "gravatar_id": "",\
      "url": "https://api.github.com/users/octocat",\
      "html_url": "https://github.com/octocat",\
      "followers_url": "https://api.github.com/users/octocat/followers",\
      "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
      "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
      "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
      "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
      "organizations_url": "https://api.github.com/users/octocat/orgs",\
      "repos_url": "https://api.github.com/users/octocat/repos",\
      "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
      "received_events_url": "https://api.github.com/users/octocat/received_events",\
      "type": "User",\
      "site_admin": false\
    },\
    "assets": [\
      {\
        "url": "https://api.github.com/repos/octocat/Hello-World/releases/assets/1",\
        "browser_download_url": "https://github.com/octocat/Hello-World/releases/download/v1.0.0/example.zip",\
        "id": 1,\
        "node_id": "MDEyOlJlbGVhc2VBc3NldDE=",\
        "name": "example.zip",\
        "label": "short description",\
        "state": "uploaded",\
        "content_type": "application/zip",\
        "size": 1024,\
        "digest": "sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255",\
        "download_count": 42,\
        "created_at": "2013-02-27T19:35:32Z",\
        "updated_at": "2013-02-27T19:35:32Z",\
        "uploader": {\
          "login": "octocat",\
          "id": 1,\
          "node_id": "MDQ6VXNlcjE=",\
          "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
          "gravatar_id": "",\
          "url": "https://api.github.com/users/octocat",\
          "html_url": "https://github.com/octocat",\
          "followers_url": "https://api.github.com/users/octocat/followers",\
          "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
          "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
          "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
          "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
          "organizations_url": "https://api.github.com/users/octocat/orgs",\
          "repos_url": "https://api.github.com/users/octocat/repos",\
          "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
          "received_events_url": "https://api.github.com/users/octocat/received_events",\
          "type": "User",\
          "site_admin": false\
        }\
      }\
    ]\
}\
]`

## [Create a release](https://docs.github.com/en/rest/releases/releases\#create-a-release)

Users with push access to the repository can create a release.

Note

If the commit identified by `target_commitish` (or, when `target_commitish` is omitted, the latest commit on the default branch) adds or modifies any file under `.github/workflows/` relative to the repository's default branch, the authenticating token must be authorized to modify workflows. Otherwise, this endpoint returns `404 Not Found`; some authentication paths surface `403 Resource not accessible by integration` instead.

OAuth app tokens and personal access tokens (classic) need the `workflow` scope when the resolved target commit modifies workflow files. Fine-grained access tokens and GitHub App installation tokens also need the "Workflows" repository permission (write). The `GITHUB_TOKEN` available to GitHub Actions cannot be authorized for this; for more information, see " [Automatic token authentication](https://docs.github.com/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token)".

This endpoint triggers [notifications](https://docs.github.com/github/managing-subscriptions-and-notifications-on-github/about-notifications). Creating content too quickly using this endpoint may result in secondary rate limiting. For more information, see " [Rate limits for the API](https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits)" and " [Best practices for using the REST API](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api)."

### [Fine-grained access tokens for "Create a release"](https://docs.github.com/en/rest/releases/releases\#create-a-release--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have at least one of the following permission sets:

- "Contents" repository permissions (write)
- "Contents" repository permissions (write) and "Workflows" repository permissions (write)

### [Parameters for "Create a release"](https://docs.github.com/en/rest/releases/releases\#create-a-release--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |

Path parameters

| Name, Type, Description |
| --- |
| `tag_name`stringRequired<br>The name of the tag. |
| `target_commitish`string<br>Specifies the commitish value that determines where the Git tag is created from. Can be any branch or commit SHA. Unused if the Git tag already exists. Default: the repository's default branch. |
| `name`string<br>The name of the release. |
| `body`string<br>Text describing the contents of the tag. |
| `draft`boolean<br>`true` to create a draft (unpublished) release, `false` to create a published one.<br>Default: `false` |
| `prerelease`boolean<br>`true` to identify the release as a prerelease. `false` to identify the release as a full release.<br>Default: `false` |
| `discussion_category_name`string<br>If specified, a discussion of the specified category is created and linked to the release. The value must be a category that already exists in the repository. For more information, see " [Managing categories for discussions in your repository](https://docs.github.com/discussions/managing-discussions-for-your-community/managing-categories-for-discussions-in-your-repository)." |
| `generate_release_notes`boolean<br>Whether to automatically generate the name and body for this release. If `name` is specified, the specified name will be used; otherwise, a name will be automatically generated. If `body` is specified, the body will be pre-pended to the automatically generated notes.<br>Default: `false` |
| `make_latest`string<br>Specifies whether this release should be set as the latest release for the repository. Drafts and prereleases cannot be set as latest. Defaults to `true` for newly published releases. `legacy` specifies that the latest release should be determined based on the release creation date and higher semantic version.<br>Default: `true`<br>Can be one of:`true`,`false`,`legacy` |

Body parameters

### [HTTP response status codes for "Create a release"](https://docs.github.com/en/rest/releases/releases\#create-a-release--status-codes)

| Status code | Description |
| --- | --- |
| `201` | Created |
| `404` | Not Found if the discussion category name is invalid |
| `422` | Validation failed, or the endpoint has been spammed. |

### [Code samples for "Create a release"](https://docs.github.com/en/rest/releases/releases\#create-a-release--code-samples)

#### Request example

post/repos/{owner}/{repo}/releases

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases \
  -d '{"tag_name":"v1.0.0","target_commitish":"master","name":"v1.0.0","body":"Description of the release","draft":false,"prerelease":false,"generate_release_notes":false}'`

#### Response

- Example response

- Response schema


`Status: 201`

`{
"url": "https://api.github.com/repos/octocat/Hello-World/releases/1",
"html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0",
"assets_url": "https://api.github.com/repos/octocat/Hello-World/releases/1/assets",
"upload_url": "https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}",
"tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",
"zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",
"discussion_url": "https://github.com/octocat/Hello-World/discussions/90",
"id": 1,
"node_id": "MDc6UmVsZWFzZTE=",
"tag_name": "v1.0.0",
"target_commitish": "master",
"name": "v1.0.0",
"body": "Description of the release",
"draft": false,
"prerelease": false,
"immutable": false,
"created_at": "2013-02-27T19:35:32Z",
"published_at": "2013-02-27T19:35:32Z",
"author": {
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://github.com/images/error/octocat_happy.gif",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false
},
"assets": [\
    {\
      "url": "https://api.github.com/repos/octocat/Hello-World/releases/assets/1",\
      "browser_download_url": "https://github.com/octocat/Hello-World/releases/download/v1.0.0/example.zip",\
      "id": 1,\
      "node_id": "MDEyOlJlbGVhc2VBc3NldDE=",\
      "name": "example.zip",\
      "label": "short description",\
      "state": "uploaded",\
      "content_type": "application/zip",\
      "size": 1024,\
      "digest": "sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255",\
      "download_count": 42,\
      "created_at": "2013-02-27T19:35:32Z",\
      "updated_at": "2013-02-27T19:35:32Z",\
      "uploader": {\
        "login": "octocat",\
        "id": 1,\
        "node_id": "MDQ6VXNlcjE=",\
        "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
        "gravatar_id": "",\
        "url": "https://api.github.com/users/octocat",\
        "html_url": "https://github.com/octocat",\
        "followers_url": "https://api.github.com/users/octocat/followers",\
        "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
        "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
        "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
        "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
        "organizations_url": "https://api.github.com/users/octocat/orgs",\
        "repos_url": "https://api.github.com/users/octocat/repos",\
        "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
        "received_events_url": "https://api.github.com/users/octocat/received_events",\
        "type": "User",\
        "site_admin": false\
      }\
    }\
]
}`

## [Generate release notes content for a release](https://docs.github.com/en/rest/releases/releases\#generate-release-notes-content-for-a-release)

Generate a name and body describing a [release](https://docs.github.com/rest/releases/releases#get-a-release). The body content will be markdown formatted and contain information like the changes since last release and users who contributed. The generated release notes are not saved anywhere. They are intended to be generated and used when creating a new release.

### [Fine-grained access tokens for "Generate release notes content for a release"](https://docs.github.com/en/rest/releases/releases\#generate-release-notes-content-for-a-release--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have the following permission set:

- "Contents" repository permissions (write)

### [Parameters for "Generate release notes content for a release"](https://docs.github.com/en/rest/releases/releases\#generate-release-notes-content-for-a-release--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |

Path parameters

| Name, Type, Description |
| --- |
| `tag_name`stringRequired<br>The tag name for the release. This can be an existing tag or a new one. |
| `target_commitish`string<br>Specifies the commitish value that will be the target for the release's tag. Required if the supplied tag\_name does not reference an existing tag. Ignored if the tag\_name already exists. |
| `previous_tag_name`string<br>The name of the previous tag to use as the starting point for the release notes. Use to manually specify the range for the set of changes considered as part this release. |
| `configuration_file_path`string<br>Specifies a path to a file in the repository containing configuration settings used for generating the release notes. If unspecified, the configuration file located in the repository at '.github/release.yml' or '.github/release.yaml' will be used. If that is not present, the default configuration will be used. |

Body parameters

### [HTTP response status codes for "Generate release notes content for a release"](https://docs.github.com/en/rest/releases/releases\#generate-release-notes-content-for-a-release--status-codes)

| Status code | Description |
| --- | --- |
| `200` | Name and body of generated release notes |
| `404` | Resource not found |

### [Code samples for "Generate release notes content for a release"](https://docs.github.com/en/rest/releases/releases\#generate-release-notes-content-for-a-release--code-samples)

#### Request example

post/repos/{owner}/{repo}/releases/generate-notes

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases/generate-notes \
  -d '{"tag_name":"v1.0.0","target_commitish":"main","previous_tag_name":"v0.9.2","configuration_file_path":".github/custom_release_config.yml"}'`

#### Name and body of generated release notes

- Example response

- Response schema


`Status: 200`

`{
"name": "Release v1.0.0 is now available!",
"body": "##Changes in Release v1.0.0 ... ##Contributors @monalisa"
}`

## [Get the latest release](https://docs.github.com/en/rest/releases/releases\#get-the-latest-release)

View the latest published full release for the repository.

The latest release is the most recent non-prerelease, non-draft release, sorted by the `created_at` attribute. The `created_at` attribute is the date of the commit used for the release, and not the date when the release was drafted or published.

### [Fine-grained access tokens for "Get the latest release"](https://docs.github.com/en/rest/releases/releases\#get-the-latest-release--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have the following permission set:

- "Contents" repository permissions (read)

This endpoint can be used without authentication or the aforementioned permissions if only public resources are requested.

### [Parameters for "Get the latest release"](https://docs.github.com/en/rest/releases/releases\#get-the-latest-release--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |

Path parameters

### [HTTP response status codes for "Get the latest release"](https://docs.github.com/en/rest/releases/releases\#get-the-latest-release--status-codes)

| Status code | Description |
| --- | --- |
| `200` | OK |
| `404` | Resource not found |

### [Code samples for "Get the latest release"](https://docs.github.com/en/rest/releases/releases\#get-the-latest-release--code-samples)

#### Request example

get/repos/{owner}/{repo}/releases/latest

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases/latest`

#### Response

- Example response

- Response schema


`Status: 200`

`{
"url": "https://api.github.com/repos/octocat/Hello-World/releases/1",
"html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0",
"assets_url": "https://api.github.com/repos/octocat/Hello-World/releases/1/assets",
"upload_url": "https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}",
"tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",
"zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",
"discussion_url": "https://github.com/octocat/Hello-World/discussions/90",
"id": 1,
"node_id": "MDc6UmVsZWFzZTE=",
"tag_name": "v1.0.0",
"target_commitish": "master",
"name": "v1.0.0",
"body": "Description of the release",
"draft": false,
"prerelease": false,
"immutable": false,
"created_at": "2013-02-27T19:35:32Z",
"published_at": "2013-02-27T19:35:32Z",
"author": {
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://github.com/images/error/octocat_happy.gif",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false
},
"assets": [\
    {\
      "url": "https://api.github.com/repos/octocat/Hello-World/releases/assets/1",\
      "browser_download_url": "https://github.com/octocat/Hello-World/releases/download/v1.0.0/example.zip",\
      "id": 1,\
      "node_id": "MDEyOlJlbGVhc2VBc3NldDE=",\
      "name": "example.zip",\
      "label": "short description",\
      "state": "uploaded",\
      "content_type": "application/zip",\
      "size": 1024,\
      "digest": "sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255",\
      "download_count": 42,\
      "created_at": "2013-02-27T19:35:32Z",\
      "updated_at": "2013-02-27T19:35:32Z",\
      "uploader": {\
        "login": "octocat",\
        "id": 1,\
        "node_id": "MDQ6VXNlcjE=",\
        "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
        "gravatar_id": "",\
        "url": "https://api.github.com/users/octocat",\
        "html_url": "https://github.com/octocat",\
        "followers_url": "https://api.github.com/users/octocat/followers",\
        "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
        "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
        "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
        "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
        "organizations_url": "https://api.github.com/users/octocat/orgs",\
        "repos_url": "https://api.github.com/users/octocat/repos",\
        "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
        "received_events_url": "https://api.github.com/users/octocat/received_events",\
        "type": "User",\
        "site_admin": false\
      }\
    }\
]
}`

## [Get a release by tag name](https://docs.github.com/en/rest/releases/releases\#get-a-release-by-tag-name)

Get a published release with the specified tag.

### [Fine-grained access tokens for "Get a release by tag name"](https://docs.github.com/en/rest/releases/releases\#get-a-release-by-tag-name--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have the following permission set:

- "Contents" repository permissions (read)

This endpoint can be used without authentication or the aforementioned permissions if only public resources are requested.

### [Parameters for "Get a release by tag name"](https://docs.github.com/en/rest/releases/releases\#get-a-release-by-tag-name--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |
| `tag`stringRequired<br>tag parameter |

Path parameters

### [HTTP response status codes for "Get a release by tag name"](https://docs.github.com/en/rest/releases/releases\#get-a-release-by-tag-name--status-codes)

| Status code | Description |
| --- | --- |
| `200` | OK |
| `404` | Resource not found |

### [Code samples for "Get a release by tag name"](https://docs.github.com/en/rest/releases/releases\#get-a-release-by-tag-name--code-samples)

#### Request example

get/repos/{owner}/{repo}/releases/tags/{tag}

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases/tags/TAG`

#### Response

- Example response

- Response schema


`Status: 200`

`{
"url": "https://api.github.com/repos/octocat/Hello-World/releases/1",
"html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0",
"assets_url": "https://api.github.com/repos/octocat/Hello-World/releases/1/assets",
"upload_url": "https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}",
"tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",
"zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",
"discussion_url": "https://github.com/octocat/Hello-World/discussions/90",
"id": 1,
"node_id": "MDc6UmVsZWFzZTE=",
"tag_name": "v1.0.0",
"target_commitish": "master",
"name": "v1.0.0",
"body": "Description of the release",
"draft": false,
"prerelease": false,
"immutable": false,
"created_at": "2013-02-27T19:35:32Z",
"published_at": "2013-02-27T19:35:32Z",
"author": {
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://github.com/images/error/octocat_happy.gif",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false
},
"assets": [\
    {\
      "url": "https://api.github.com/repos/octocat/Hello-World/releases/assets/1",\
      "browser_download_url": "https://github.com/octocat/Hello-World/releases/download/v1.0.0/example.zip",\
      "id": 1,\
      "node_id": "MDEyOlJlbGVhc2VBc3NldDE=",\
      "name": "example.zip",\
      "label": "short description",\
      "state": "uploaded",\
      "content_type": "application/zip",\
      "size": 1024,\
      "digest": "sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255",\
      "download_count": 42,\
      "created_at": "2013-02-27T19:35:32Z",\
      "updated_at": "2013-02-27T19:35:32Z",\
      "uploader": {\
        "login": "octocat",\
        "id": 1,\
        "node_id": "MDQ6VXNlcjE=",\
        "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
        "gravatar_id": "",\
        "url": "https://api.github.com/users/octocat",\
        "html_url": "https://github.com/octocat",\
        "followers_url": "https://api.github.com/users/octocat/followers",\
        "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
        "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
        "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
        "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
        "organizations_url": "https://api.github.com/users/octocat/orgs",\
        "repos_url": "https://api.github.com/users/octocat/repos",\
        "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
        "received_events_url": "https://api.github.com/users/octocat/received_events",\
        "type": "User",\
        "site_admin": false\
      }\
    }\
]
}`

## [Get a release](https://docs.github.com/en/rest/releases/releases\#get-a-release)

Gets a public release with the specified release ID.

Note

This returns an `upload_url` key corresponding to the endpoint for uploading release assets. This key is a hypermedia resource. For more information, see " [Getting started with the REST API](https://docs.github.com/rest/using-the-rest-api/getting-started-with-the-rest-api#hypermedia)."

### [Fine-grained access tokens for "Get a release"](https://docs.github.com/en/rest/releases/releases\#get-a-release--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have the following permission set:

- "Contents" repository permissions (read)

This endpoint can be used without authentication or the aforementioned permissions if only public resources are requested.

### [Parameters for "Get a release"](https://docs.github.com/en/rest/releases/releases\#get-a-release--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |
| `release_id`integerRequired<br>The unique identifier of the release. |

Path parameters

### [HTTP response status codes for "Get a release"](https://docs.github.com/en/rest/releases/releases\#get-a-release--status-codes)

| Status code | Description |
| --- | --- |
| `200` | **Note:** This returns an `upload_url` key corresponding to the endpoint for uploading release assets. This key is a hypermedia resource. For more information, see " [Getting started with the REST API](https://docs.github.com/rest/using-the-rest-api/getting-started-with-the-rest-api#hypermedia)." |
| `401` | Unauthorized |

### [Code samples for "Get a release"](https://docs.github.com/en/rest/releases/releases\#get-a-release--code-samples)

#### Request example

get/repos/{owner}/{repo}/releases/{release\_id}

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases/RELEASE_ID`

#### **Note:** This returns an `upload_url` key corresponding to the endpoint for uploading release assets. This key is a hypermedia resource. For more information, see " [Getting started with the REST API](https://docs.github.com/rest/using-the-rest-api/getting-started-with-the-rest-api\#hypermedia)."

- Example response

- Response schema


`Status: 200`

`{
"url": "https://api.github.com/repos/octocat/Hello-World/releases/1",
"html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0",
"assets_url": "https://api.github.com/repos/octocat/Hello-World/releases/1/assets",
"upload_url": "https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}",
"tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",
"zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",
"discussion_url": "https://github.com/octocat/Hello-World/discussions/90",
"id": 1,
"node_id": "MDc6UmVsZWFzZTE=",
"tag_name": "v1.0.0",
"target_commitish": "master",
"name": "v1.0.0",
"body": "Description of the release",
"draft": false,
"prerelease": false,
"immutable": false,
"created_at": "2013-02-27T19:35:32Z",
"published_at": "2013-02-27T19:35:32Z",
"author": {
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://github.com/images/error/octocat_happy.gif",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false
},
"assets": [\
    {\
      "url": "https://api.github.com/repos/octocat/Hello-World/releases/assets/1",\
      "browser_download_url": "https://github.com/octocat/Hello-World/releases/download/v1.0.0/example.zip",\
      "id": 1,\
      "node_id": "MDEyOlJlbGVhc2VBc3NldDE=",\
      "name": "example.zip",\
      "label": "short description",\
      "state": "uploaded",\
      "content_type": "application/zip",\
      "size": 1024,\
      "digest": "sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255",\
      "download_count": 42,\
      "created_at": "2013-02-27T19:35:32Z",\
      "updated_at": "2013-02-27T19:35:32Z",\
      "uploader": {\
        "login": "octocat",\
        "id": 1,\
        "node_id": "MDQ6VXNlcjE=",\
        "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
        "gravatar_id": "",\
        "url": "https://api.github.com/users/octocat",\
        "html_url": "https://github.com/octocat",\
        "followers_url": "https://api.github.com/users/octocat/followers",\
        "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
        "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
        "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
        "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
        "organizations_url": "https://api.github.com/users/octocat/orgs",\
        "repos_url": "https://api.github.com/users/octocat/repos",\
        "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
        "received_events_url": "https://api.github.com/users/octocat/received_events",\
        "type": "User",\
        "site_admin": false\
      }\
    }\
]
}`

## [Update a release](https://docs.github.com/en/rest/releases/releases\#update-a-release)

Users with push access to the repository can edit a release.

Note

If the resolved target commit (the new value of `target_commitish` if you are changing it, otherwise the existing target) adds or modifies any file under `.github/workflows/` relative to the repository's default branch, the authenticating token must be authorized to modify workflows. Otherwise, this endpoint returns `404 Not Found`; some authentication paths surface `403 Resource not accessible by integration` instead.

OAuth app tokens and personal access tokens (classic) need the `workflow` scope when the resolved target commit modifies workflow files. Fine-grained access tokens and GitHub App installation tokens also need the "Workflows" repository permission (write). The `GITHUB_TOKEN` available to GitHub Actions cannot be authorized for this; for more information, see " [Automatic token authentication](https://docs.github.com/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token)".

### [Fine-grained access tokens for "Update a release"](https://docs.github.com/en/rest/releases/releases\#update-a-release--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have at least one of the following permission sets:

- "Contents" repository permissions (write)
- "Contents" repository permissions (write) and "Workflows" repository permissions (write)

### [Parameters for "Update a release"](https://docs.github.com/en/rest/releases/releases\#update-a-release--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |
| `release_id`integerRequired<br>The unique identifier of the release. |

Path parameters

| Name, Type, Description |
| --- |
| `tag_name`string<br>The name of the tag. |
| `target_commitish`string<br>Specifies the commitish value that determines where the Git tag is created from. Can be any branch or commit SHA. Unused if the Git tag already exists. Default: the repository's default branch. |
| `name`string<br>The name of the release. |
| `body`string<br>Text describing the contents of the tag. |
| `draft`boolean<br>`true` makes the release a draft, and `false` publishes the release. |
| `prerelease`boolean<br>`true` to identify the release as a prerelease, `false` to identify the release as a full release. |
| `make_latest`string<br>Specifies whether this release should be set as the latest release for the repository. Drafts and prereleases cannot be set as latest. Defaults to `true` for newly published releases. `legacy` specifies that the latest release should be determined based on the release creation date and higher semantic version.<br>Default: `true`<br>Can be one of:`true`,`false`,`legacy` |
| `discussion_category_name`string<br>If specified, a discussion of the specified category is created and linked to the release. The value must be a category that already exists in the repository. If there is already a discussion linked to the release, this parameter is ignored. For more information, see " [Managing categories for discussions in your repository](https://docs.github.com/discussions/managing-discussions-for-your-community/managing-categories-for-discussions-in-your-repository)." |

Body parameters

### [HTTP response status codes for "Update a release"](https://docs.github.com/en/rest/releases/releases\#update-a-release--status-codes)

| Status code | Description |
| --- | --- |
| `200` | OK |
| `404` | Not Found if the discussion category name is invalid |

### [Code samples for "Update a release"](https://docs.github.com/en/rest/releases/releases\#update-a-release--code-samples)

#### Request example

patch/repos/{owner}/{repo}/releases/{release\_id}

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -X PATCH \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases/RELEASE_ID \
  -d '{"tag_name":"v1.0.0","target_commitish":"master","name":"v1.0.0","body":"Description of the release","draft":false,"prerelease":false}'`

#### Response

- Example response

- Response schema


`Status: 200`

`{
"url": "https://api.github.com/repos/octocat/Hello-World/releases/1",
"html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0",
"assets_url": "https://api.github.com/repos/octocat/Hello-World/releases/1/assets",
"upload_url": "https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}",
"tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",
"zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",
"discussion_url": "https://github.com/octocat/Hello-World/discussions/90",
"id": 1,
"node_id": "MDc6UmVsZWFzZTE=",
"tag_name": "v1.0.0",
"target_commitish": "master",
"name": "v1.0.0",
"body": "Description of the release",
"draft": false,
"prerelease": false,
"immutable": false,
"created_at": "2013-02-27T19:35:32Z",
"published_at": "2013-02-27T19:35:32Z",
"author": {
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://github.com/images/error/octocat_happy.gif",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false
},
"assets": [\
    {\
      "url": "https://api.github.com/repos/octocat/Hello-World/releases/assets/1",\
      "browser_download_url": "https://github.com/octocat/Hello-World/releases/download/v1.0.0/example.zip",\
      "id": 1,\
      "node_id": "MDEyOlJlbGVhc2VBc3NldDE=",\
      "name": "example.zip",\
      "label": "short description",\
      "state": "uploaded",\
      "content_type": "application/zip",\
      "size": 1024,\
      "digest": "sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255",\
      "download_count": 42,\
      "created_at": "2013-02-27T19:35:32Z",\
      "updated_at": "2013-02-27T19:35:32Z",\
      "uploader": {\
        "login": "octocat",\
        "id": 1,\
        "node_id": "MDQ6VXNlcjE=",\
        "avatar_url": "https://github.com/images/error/octocat_happy.gif",\
        "gravatar_id": "",\
        "url": "https://api.github.com/users/octocat",\
        "html_url": "https://github.com/octocat",\
        "followers_url": "https://api.github.com/users/octocat/followers",\
        "following_url": "https://api.github.com/users/octocat/following{/other_user}",\
        "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",\
        "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",\
        "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",\
        "organizations_url": "https://api.github.com/users/octocat/orgs",\
        "repos_url": "https://api.github.com/users/octocat/repos",\
        "events_url": "https://api.github.com/users/octocat/events{/privacy}",\
        "received_events_url": "https://api.github.com/users/octocat/received_events",\
        "type": "User",\
        "site_admin": false\
      }\
    }\
]
}`

## [Delete a release](https://docs.github.com/en/rest/releases/releases\#delete-a-release)

Users with push access to the repository can delete a release.

### [Fine-grained access tokens for "Delete a release"](https://docs.github.com/en/rest/releases/releases\#delete-a-release--fine-grained-access-tokens)

This endpoint works with the following fine-grained token types:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The fine-grained token must have the following permission set:

- "Contents" repository permissions (write)

### [Parameters for "Delete a release"](https://docs.github.com/en/rest/releases/releases\#delete-a-release--parameters)

| Name, Type, Description |
| --- |
| `accept`string<br>Setting to `application/vnd.github+json` is recommended. |

Headers

| Name, Type, Description |
| --- |
| `owner`stringRequired<br>The account owner of the repository. The name is not case sensitive. |
| `repo`stringRequired<br>The name of the repository without the `.git` extension. The name is not case sensitive. |
| `release_id`integerRequired<br>The unique identifier of the release. |

Path parameters

### [HTTP response status codes for "Delete a release"](https://docs.github.com/en/rest/releases/releases\#delete-a-release--status-codes)

| Status code | Description |
| --- | --- |
| `204` | No Content |
| `404` | Resource not found |

### [Code samples for "Delete a release"](https://docs.github.com/en/rest/releases/releases\#delete-a-release--code-samples)

#### Request example

delete/repos/{owner}/{repo}/releases/{release\_id}

- cURL

- JavaScript

- GitHub CLI


Copy to clipboard curl request example

`curl -L \
  -X DELETE \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
https://api.github.com/repos/OWNER/REPO/releases/RELEASE_ID`

#### Response

`Status: 204`