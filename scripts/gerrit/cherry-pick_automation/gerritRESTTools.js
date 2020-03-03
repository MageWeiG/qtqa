/* eslint-disable no-unused-vars */
/****************************************************************************
 **
 ** Copyright (C) 2020 The Qt Company Ltd.
 ** Contact: https://www.qt.io/licensing/
 **
 ** This file is part of the qtqa module of the Qt Toolkit.
 **
 ** $QT_BEGIN_LICENSE:LGPL$
 ** Commercial License Usage
 ** Licensees holding valid commercial Qt licenses may use this file in
 ** accordance with the commercial license agreement provided with the
 ** Software or, alternatively, in accordance with the terms contained in
 ** a written agreement between you and The Qt Company. For licensing terms
 ** and conditions see https://www.qt.io/terms-conditions. For further
 ** information use the contact form at https://www.qt.io/contact-us.
 **
 ** GNU Lesser General Public License Usage
 ** Alternatively, this file may be used under the terms of the GNU Lesser
 ** General Public License version 3 as published by the Free Software
 ** Foundation and appearing in the file LICENSE.LGPL3 included in the
 ** packaging of this file. Please review the following information to
 ** ensure the GNU Lesser General Public License version 3 requirements
 ** will be met: https://www.gnu.org/licenses/lgpl-3.0.html.
 **
 ** GNU General Public License Usage
 ** Alternatively, this file may be used under the terms of the GNU
 ** General Public License version 2.0 or (at your option) the GNU General
 ** Public license version 3 or any later version approved by the KDE Free
 ** Qt Foundation. The licenses are as published by the Free Software
 ** Foundation and appearing in the file LICENSE.GPL2 and LICENSE.GPL3
 ** included in the packaging of this file. Please review the following
 ** information to ensure the GNU General Public License requirements will
 ** be met: https://www.gnu.org/licenses/gpl-2.0.html and
 ** https://www.gnu.org/licenses/gpl-3.0.html.
 **
 ** $QT_END_LICENSE$
 **
 ****************************************************************************/

exports.id = "gerritRESTTools";

const axios = require("axios");
const safeJsonStringify = require("safe-json-stringify");

const toolbox = require("./toolbox");
const config = require("./config.json");
const Logger = require("./logger");
const logger = new Logger();

// Set default values with the config file, but prefer environment variable.
function envOrConfig(ID) {
  if (process.env[ID])
    return process.env[ID];
  return config[ID];
}

let gerritURL = envOrConfig("GERRIT_URL");
let gerritPort = envOrConfig("GERRIT_PORT");
let gerritAuth = {
  username: envOrConfig("GERRIT_USER"),
  password: envOrConfig("GERRIT_PASS")
};

// Assemble the gerrit URL, and tack on http/https if it's not already
// in the URL. Add the port if it's non-standard, and assume https
// if the port is anything other than port 80.
let gerritResolvedURL = /^(http)s?:\/\//g.test(gerritURL)
  ? gerritURL
  : `${gerritPort == 80 ? "http" : "https"}://${gerritURL}`;
gerritResolvedURL += gerritPort != 80 && gerritPort != 443 ? ":" + gerritPort : "";

// Return an assembled url to use as a base for requests to gerrit.
function gerritBaseURL(api, id) {
  return `${gerritResolvedURL}/a/${api}/${id}`;
}

// Make a REST API call to gerrit to cherry pick the change to a requested branch.
// Splice out the "Pick-to: keyword from the old commit message, but keep the rest."
exports.generateCherryPick = generateCherryPick;
function generateCherryPick(changeJSON, parent, destinationBranch, callback) {
  const changeIDPos = changeJSON.change.commitMessage.lastIndexOf("Change-Id:");
  const newCommitMessage = changeJSON.change.commitMessage
    .slice(0, changeIDPos)
    .concat(`Cherry-picked from branch: ${changeJSON.change.branch}\n\n`)
    .concat(changeJSON.change.commitMessage.slice(changeIDPos))
    .replace(/^(Pick-to:(?:\s+(?:\d\.\d+\.\d+|\d\.\d+|dev))+)\s?/gm, "")
    .replace(/^(Reviewed-by:\s(\w.+)$)\s?/gm, "");
  let url = `${gerritBaseURL("changes", changeJSON.fullChangeID)}/revisions/${
    changeJSON.patchSet.revision}/cherrypick`;
  let data = {
    message: newCommitMessage, destination: destinationBranch,
    notify: "NONE", base: parent, keep_reviewers: false,
    allow_conflicts: true // Add conflict markers to files in the resulting cherry-pick.
  };
  logger.log(
    `New commit message for ${changeJSON.change.branch}:\n${newCommitMessage}`,
    "verbose", changeJSON.uuid
  );
  logger.log(
    `POST request to: ${url}\nRequest Body: ${safeJsonStringify(data)}`,
    "debug", changeJSON.uuid
  );
  axios({ method: "post", url: url, data: data, auth: gerritAuth })
    .then(function (response) {
      // Send an update with only the branch before trying to parse the raw response.
      // If the parse is bad, then at least we stored a status with the branch.
      toolbox.addToCherryPickStateUpdateQueue(
        changeJSON.uuid, { branch: destinationBranch, statusDetail: "pickCreated" },
        "validBranchReadyForPick"
      );
      let parsedResponse = JSON.parse(response.data.slice(4));
      toolbox.addToCherryPickStateUpdateQueue(
        changeJSON.uuid,
        { branch: destinationBranch, cherrypickID: parsedResponse.id, statusDetail: "pickCreated" },
        "validBranchReadyForPick"
      );
      callback(true, parsedResponse);
    })
    .catch(function (error) {
      if (error.response) {
        // The server responded with a code outside of 2xx. Something's
        // actually wrong with the cherrypick request.
        logger.log(
          `An error occurred in POST to "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", changeJSON.uuid
        );
        callback(false, { statusDetail: error.response.data, statusCode: error.response.status });
      } else if (error.request) {
        // The server failed to respond. Try the pick later.
        callback(false, "retry");
      } else {
        // Something unexpected happened in generating the HTTP request itself.
        logger.log(
          `UNKNOWN ERROR posting cherry-pick for ${destinationBranch}: ${safeJsonStringify(error)}`,
          "error", changeJSON.uuid
        );
        callback(false, error.message);
      }
    });
}

// Post a review to the change on the latest revision.
exports.setApproval = setApproval;
function setApproval(parentUuid, cherryPickJSON, approvalScore, message, notifyScope, callback) {
  let url = `${gerritBaseURL("changes", cherryPickJSON.id)}/revisions/current/review`;
  let data = {
    message: message ? message : "", notify: notifyScope ? notifyScope : "OWNER",
    labels: { "Code-Review": approvalScore, "Sanity-Review": 1 },
    omit_duplicate_comments: true, ready: true
  };
  logger.log(
    `POST request to: ${url}\nRequest Body: ${safeJsonStringify(data)}`,
    "debug", parentUuid
  );

  axios({ method: "post", url: url, data: data, auth: gerritAuth })
    .then(function (response) {
      logger.log(
        `Successfully set approval to "${approvalScore}" on change ${cherryPickJSON.id}`,
        "verbose", parentUuid
      );
      callback(true, undefined);
    })
    .catch(function (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        logger.log(
          `An error occurred in POST to "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", parentUuid
        );
        callback(false, error.response.status);
      } else if (error.request) {
        // The request was made but no response was received
        callback(false, "retry");
      } else {
        // Something unexpected happened in generating the HTTP request itself.
        logger.log(
          `UNKNOWN ERROR while setting approval for ${
            cherryPickJSON.id}: ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
        callback(false, error.message);
      }
    });
}

// Stage a conflict-free change to Qt's CI system.
// NOTE: This requires gerrit to be extended with "gerrit-plugin-qt-workflow"
// https://codereview.qt-project.org/admin/repos/qtqa/gerrit-plugin-qt-workflow
exports.stageCherryPick = stageCherryPick;
function stageCherryPick(parentUuid, cherryPickJSON, callback) {
  let url =`${
    gerritBaseURL("changes", cherryPickJSON.id)}/revisions/current/gerrit-plugin-qt-workflow~stage`;

  logger.log(`POST request to: ${url}`, "debug", parentUuid);

  axios({ method: "post", url: url, data: {}, auth: gerritAuth })
    .then(function (response) {
      logger.log(`Successfully staged "${cherryPickJSON.id}"`, "info", parentUuid);
      callback(true, undefined);
    })
    .catch(function (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx

        // Call this a permenant failure for staging. Ask the owner to handle it.
        logger.log(
          `An error occurred in POST to "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", parentUuid
        );
        callback(false, { status: error.response.status, data: error.response.data });
      } else if (error.request) {
        // The request was made but no response was received. Retry it later.
        callback(false, "retry");
      } else {
        // Something happened in setting up the request that triggered an Error
        logger.log(
          `Error in HTTP request while trying to stage. Error: ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
        callback(false, error.message);
      }
    });
}

// Post a comment to the change on the latest revision.
exports.postGerritComment = postGerritComment;
function postGerritComment(parentUuid, fullChangeID, revision, message, notifyScope, callback) {
  let url = `${gerritBaseURL("changes", fullChangeID)}/revisions/${
    revision ? revision : "current"}/review`;
  let data = { message: message, notify: notifyScope ? notifyScope : "OWNER_REVIEWERS" };

  logger.log(
    `POST request to: ${url}\nRequest Body: ${safeJsonStringify(data)}`,
    "debug", parentUuid
  );

  axios({ method: "post", url: url, data: data, auth: gerritAuth })
    .then(function (response) {
      logger.log(`Posted comment "${message}" to change "${fullChangeID}"`, "info", parentUuid);
      callback(true, undefined);
    })
    .catch(function (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        logger.log(
          `An error occurred in POST (gerrit comment) to "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", parentUuid
        );
        callback(false, error.response);
      } else if (error.request) {
        // The request was made but no response was received
        callback(false, "retry");
      } else {
        // Something happened in setting up the request that triggered an Error
        logger.log(
          `Error in HTTP request while posting comment. Error: ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
        callback(false, error.message);
      }
    });
}

// Query gerrit project to make sure a target cherry-pick branch exists.
exports.validateBranch = function (parentUuid, project, branch, callback) {
  let url = `${gerritBaseURL("projects", encodeURIComponent(project))}/branches/${branch}`;
  logger.log(`GET request to: ${url}`, "debug", parentUuid);
  axios.get(url, { auth: gerritAuth })
    .then(function (response) {
      // Execute callback with the target branch head SHA1 of that branch
      callback(true, JSON.parse(response.data.slice(4)).revision);
    })
    .catch(function (error) {
      if (error.response) {
        if (error.response.status == 404) {
          // Not a valid branch according to gerrit.
          callback(false, error.response);
        } else {
          logger.log(
            `An error occurred in GET "${url}". Error message: ${
              error.response.status}: ${error.response.data}`,
            "error", parentUuid
          );
        }
      } else if (error.request) {
        // Gerrit failed to respond, try again later and resume the process.
        callback(false, "retry");
      } else {
        // Something happened in setting up the request that triggered an Error
        logger.log(
          `Error in HTTP request while requesting branch validation for ${
            branch}. Error: ${safeJsonStringify(error)}`,
          "warn", parentUuid
        );
        callback(false, error.message);
      }
    });
};

// Query gerrit commit for it's relation chain. Returns a list of changes.
exports.queryRelated = function (parentUuid, fullChangeID, callback) {
  let url = `${gerritBaseURL("changes", fullChangeID)}/revisions/current/related`;
  logger.log(`GET request to: ${url}`, "debug", parentUuid);
  axios.get(url, { auth: gerritAuth })
    .then(function (response) {
      // Execute callback and return the list of changes
      logger.log(`Raw Response:\n${response.data}`, "debug", parentUuid);
      callback(true, JSON.parse(response.data.slice(4)).changes);
    })
    .catch(function (error) {
      if (error.response) {
        // An error here would be unexpected. Changes without related changes
        // should still return valid JSON with an empty "changes" field
        callback(false, error.response);
        logger.log(
          `An error occurred in GET "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", parentUuid
        );
      } else if (error.request) {
        // Gerrit failed to respond, try again later and resume the process.
        callback(false, "retry");
      } else {
        // Something happened in setting up the request that triggered an Error
        logger.log(
          `Error in HTTP request while trying to query for related changes on ${
            fullChangeID}. Error: ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
        callback(false, error.message);
      }
    });
};

// Query gerrit for a change and return it along with the current revision if it exists.
exports.queryChange = function (parentUuid, fullChangeID, callback) {
  let url = `${gerritBaseURL("changes", fullChangeID)}/?o=CURRENT_COMMIT&o=CURRENT_REVISION`;
  logger.log(`Querying gerrit for ${url}`, "debug", parentUuid);
  axios.get(url, { auth: gerritAuth })
    .then(function (response) {
      // Execute callback and return the list of changes
      logger.log(`Raw response: ${response.data}`, "debug", parentUuid);
      callback(true, JSON.parse(response.data.slice(4)));
    })
    .catch(function (error) {
      if (error.response) {
        if (error.response.status == 404) {
          // Change does not exist. Depending on usage, this may not
          // be considered an error, so only write an error trace if
          // a status other than 404 is returned.
          callback(false, { statusCode: 404 });
        } else {
          // Some other error was returned
          logger.log(
            `An error occurred in GET "${url}". Error message: ${
              error.response.status}: ${error.response.data}`,
            "error", parentUuid
          );
          callback(false, { statusCode: error.response.status, statusDetail: error.response.data });
        }
      } else if (error.request) {
        // Gerrit failed to respond, try again later and resume the process.
        callback(false, "retry");
      } else {
        // Something happened in setting up the request that triggered an Error
        logger.log(
          `Error in HTTP request while trying to query ${
            fullChangeID}. ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
        callback(false, error.message);
      }
    });
};

// Set the assignee of a change
exports.setChangeAssignee = setChangeAssignee;
function setChangeAssignee(parentUuid, changeJSON, newAssignee, callback) {
  let url = `${gerritBaseURL("changes", changeJSON.id)}/assignee`;
  let data = { assignee: newAssignee };
  logger.log(
    `PUT request to: ${url}\nRequest Body: ${safeJsonStringify(data)}`,
    "debug", parentUuid
  );
  axios({ method: "PUT", url: url, data: data, auth: gerritAuth })
    .then(function (response) {
      logger.log(
        `Set new assignee "${newAssignee}" on "${changeJSON.id}"`,
        "info", changeJSON.uuid
      );
      callback(true, undefined);
    })
    .catch(function (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        logger.log(
          `An error occurred in POST to "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", parentUuid
        );
        callback(false, { status: error.response.status, data: error.response.data });
      } else if (error.request) {
        // The request was made but no response was received. Retry it later.
        callback(false, "retry");
      } else {
        // Something happened in setting up the request that triggered an Error
        logger.log(
          `Error in HTTP request while trying to set assignee. Error: ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
        callback(false, error.message);
      }
    });
}

// Query gerrit for the existing reviewers on a change.
exports.getChangeReviewers = getChangeReviewers;
function getChangeReviewers(parentUuid, fullChangeID, callback) {
  let url = `${gerritBaseURL("changes", fullChangeID)}/reviewers/`;
  logger.log(`GET request for ${url}`, "debug", parentUuid);
  axios
    .get(url, { auth: gerritAuth })
    .then(function (response) {
      logger.log(`Raw Response: ${response.data}`, "debug", parentUuid);
      // Execute callback with the target branch head SHA1 of that branch
      let reviewerlist = [];
      JSON.parse(response.data.slice(4)).forEach(function (item) {
        // Email as user ID is preferred. If unavailable, use the bare username.
        if (item.email)
          reviewerlist.push(item.email);
        else if (item.username)
          reviewerlist.push(item.username);
      });
      callback(true, reviewerlist);
    })
    .catch(function (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        logger.log(
          `An error occurred in GET to "${url}". Error message: ${
            error.response.status}: ${error.response.data}`,
          "error", parentUuid
        );
      } else {
        logger.log(
          `Failed to get change reviewers on ${fullChangeID}: ${safeJsonStringify(error)}`,
          "error", parentUuid
        );
      }
      // Some kind of error occurred. Have the caller take some action to
      // alert the owner that they need to add reviewers manually.
      callback(false, "manual");
    });
}

// Add new reviewers to a change.
exports.setChangeReviewers = setChangeReviewers;
function setChangeReviewers(parentUuid, fullChangeID, reviewers, callback) {
  let failedItems = [];

  function postReviewer(reviewer) {
    let url = `${gerritBaseURL("changes", fullChangeID)}/reviewers`;
    let data = { reviewer: reviewer };
    logger.log(
      `POST request to ${url}\nRequest Body: ${safeJsonStringify(data)}`,
      "debug", parentUuid
    );
    axios({ method: "post", url: url, data: data, auth: gerritAuth })
      .then(function (response) {
        logger.log(
          `Success adding ${reviewer} to ${fullChangeID}\n${response.data}`,
          "info", parentUuid
        );
      })
      .catch(function (error) {
        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          logger.log(
            `Error in POST to ${url} to add reviewer ${reviewer}: ${
              error.response.status}: ${error.response.data}`,
            "error", parentUuid
          );
        } else {
          logger.log(
            `Error adding a reviewer (${reviewer}) to ${fullChangeID}: ${safeJsonStringify(error)}`,
            "warn", parentUuid
          );
        }
        failedItems.push(reviewer);
      });
  }

  // Not possible to batch reviewer adding into a single request. Iterate through
  // the list instead.
  reviewers.forEach(postReviewer);
  callback(failedItems);
}

// Copy reviewers from one change ID to another
exports.copyChangeReviewers = copyChangeReviewers;
function copyChangeReviewers(parentUuid, fromChangeID, toChangeID, callback) {
  logger.log(`Copy change reviewers from ${fromChangeID} to ${toChangeID}`, "info", parentUuid);
  getChangeReviewers(parentUuid, fromChangeID, function (success, reviewerlist) {
    if (success) {
      setChangeReviewers(parentUuid, toChangeID, reviewerlist, function (failedItems) {
        if (callback)
          callback(true, failedItems);
      });
    } else {
      if (callback)
        callback(false, []);
    }
  });
}
