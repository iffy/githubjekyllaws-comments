import * as https from 'https'
import {v4 as mkuuid} from 'uuid'
import * as crypto from 'crypto'


interface Repo {
  owner: string;
  repo: string;
}
interface HTTPOptions {
  hostname?: string;
  port?: number;
  method: 'POST'|'GET'|'PUT'|'DELETE'|'PATCH',
  path: string;
  headers?: {[key:string]: string};
  auth?: string;
}

class GitHubClient {
  constructor(private token:string, private user:string) {

  }
  /** 
   *  request makes an HTTPS request with GitHub authentication
   */
  async request(options:HTTPOptions, payload:string|null=null):Promise<string> {
    options.hostname = options.hostname || 'api.github.com';
    options.port = options.port || 443;
    options.headers = options.headers || {};
    options.headers['User-Agent'] = this.user;
    options.auth = `${this.user}:${this.token}`;
    return new Promise<string>((resolve, reject) => {
      let req = https.request(options, res => {
        let data = '';
        res.on('data', d => {
          data = data + d;
        })
        res.on('end', () => {
          resolve(data);
        })
        res.on('error', (e) => {
          reject(e);
        })
      });
      req.on('error', (err) => {
        reject(err);
      });
      if (payload) {
        req.write(payload);
      }
      req.end();
    })
  }
}


function gravatarHash(email:string):string {
  return crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
}

interface CommentArgs {
  subdir: string;
  comment: string;
  email: string;
  name: string;
}
interface FullComment extends CommentArgs {
  date: number;
  _id: string;
}

class Commenter {
  constructor(readonly ghclient:GitHubClient, readonly src:Repo, readonly dst:Repo) {

  }

  slug(repo:Repo) {
    return `${repo.owner}/${repo.repo}`;
  }

  /**
   *  addComment adds a comment to the _data/comments directory
   *  it uses all the other methods to accomplish this
   */
  async addComment(args:CommentArgs) {

    const now = Date.now();
    const uuid = mkuuid();
    const comment:FullComment = Object.assign({}, args, {
      _id: `${now}-${uuid}`,
      date: now,
      email: args.email ? gravatarHash(args.email) : null,
    })
    const branch = `comment-${comment._id}`;

    if (!comment.comment) {
      throw new Error('No comment');
    } else if (!comment.name) {
      throw new Error('No name');
    } else if (!comment.subdir) {
      throw new Error('No subdir');
    }

    console.log('fast forwarding...')
    await this.fastForward();
    console.log(`creating branch ${branch}...`);
    await this.createBranch(branch);
    console.log(`creating comment file...`);
    await this.createCommentFile(branch, comment)
    console.log(`creating pull request...`);
    await this.createPullRequest(branch, comment)
    console.log('comment added');
    return comment;
  }

  /**
   *  fastForward updates the SRC repo master branch to match the DST
   *  repo's master branch  
   */
  async fastForward() {
    const resp = await this.ghclient.request({
      method: 'POST',
      path: `/repos/${this.slug(this.src)}/merges`,
    }, JSON.stringify({
      base: 'master',
      head: `${this.dst.owner}:master`,
    }))
    return resp
  }

  /**
   *  createBranch creates a branch from master in the source repo
   */
  async createBranch(branch:string) {
    // get master branch sha
    const body = await this.ghclient.request({
      method: 'GET',
      path: `/repos/${this.slug(this.src)}/git/refs/heads/master`,
    });
    const data = JSON.parse(body);
    const master_sha = data.object.sha;

    const newbranch = await this.ghclient.request({
      method: 'POST',
      path: `/repos/${this.slug(this.src)}/git/refs`,
    }, JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: master_sha,
    }))
    return branch;
  }

  async createCommentFile(branch:string, comment:FullComment) {
    const resp = await this.ghclient.request({
      method: 'PUT',
      path: `/repos/${this.slug(this.src)}/contents/_data/comments/${comment.subdir}/entry${comment._id}.json`,
    }, JSON.stringify({
      message: `New comment on ${comment.subdir} from ${comment.name}`,
      content: Buffer.from(JSON.stringify(comment, null, 2)).toString('base64'),
      branch: branch,
    }))
  }

  async createPullRequest(branch:string, comment:FullComment) {
    const resp = await this.ghclient.request({
      method: 'POST',
      path: `/repos/${this.slug(this.dst)}/pulls`,
    }, JSON.stringify({
      title: `New comment on ${comment.subdir} from ${comment.name}`,
      body: `New comment on \`${comment.subdir}\`:\n\n\`\`\`\n${JSON.stringify({
        name: comment.name,
        message: comment.comment,
        date: comment.date,
      }, null, 2)}\n\`\`\``,
      head: `${this.src.owner}:${branch}`,
      base: "master",
    }))
  }
}



function getEnv(x:string):string {
  const val = process.env[x];
  if (val === undefined) {
    throw new Error(`Missing env var ${x}`);
  }
  return val
}
function commenterFromEnv():Commenter {
  const ghclient = new GitHubClient(getEnv('GH_TOKEN'), getEnv('GH_USER'));
  const src:Repo = {
    owner: getEnv('SRC_OWNER'),
    repo: getEnv('SRC_REPO'),
  }
  const dst:Repo = {
    owner: getEnv('DST_OWNER'),
    repo: getEnv('DST_REPO'),
  }
  return new Commenter(ghclient, src, dst);
}

//--------------------------------------------------------------------
// AWS
//--------------------------------------------------------------------
interface AWSEvent {
  body: string;
}
interface AWSContext {
  getRemainingTimeInMillis():number;
  callbackWaitsForEmptyEventLoop: boolean;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: number;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  // identity
  // clientContext
}
interface AWSResponse {
  statusCode: number;
  body: string;
  headers?: {[k:string]:string};
}
export async function handler(event:AWSEvent, context:AWSContext):Promise<AWSResponse> {
    console.log('event', event);
    const commenter = commenterFromEnv();
    const commentargs:CommentArgs = JSON.parse(event.body);
    console.log('comment', commentargs);
    try {
      // console.log('event', event);
      const comment = await commenter.addComment(commentargs);
      return {
        statusCode: 200,
        body: 'OK',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'OPTIONS,POST',
        }
      }
    } catch(err) {
      console.log('err', err);
      return {
        statusCode: 500,
        body: 'Error',
      }
    }
};

//--------------------------------------------------------------------
// Command line
//--------------------------------------------------------------------
if (require.main === module) {
  const commenter = commenterFromEnv();
  commenter.addComment({
    subdir: 'sqlite',
    comment: 'This is my\nmultiline comment',
    name: 'Jimbo Johnson',
    email: 'foo@example.com',
  })
}