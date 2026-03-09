# Bitcoin & Lightning Infrastructure Report

This is a Bitcoin Signet node and an LND instance, along with a custom TypeScript orchestrator built to analyze and manipulate Lightning Network liquidity.

## 1. Node Infrastructure & Performance Analysis

The infrastructure is hosted on an Oracle Linux VPS, utilizing **Docker**  for fast, simple implementation and service isolation.

### 1.1 Docker-Based Deployment
The environment is orchestrated using two specialized Docker images (see [docker-compose.yml](/assets/docker-compose.yml)):
- **Bitcoin Node**: `lncm/bitcoind:v24.0`
- **Lightning Node**: `lightninglabs/lnd:v0.17.0-beta`

This containerized approach allowed for rapid deployment and consistent resource management across the VPS.

### 1.2 Node Infrastructure Analysis & Sync Acceleration
Running a full Bitcoin stack on a free-tier VPS (Oracle Cloud) presented unique engineering challenges, particularly regarding I/O wait times and validation throughput.

- **Network**: Bitcoin Signet
- **Lightning Implementation**: LND (Lightning Network Daemon) 
- **Node Public Key**: `029a3d7cb24221b068e887ead047b16fea3c5533acedda2bfbc56b370d8478dd89`
- **Initial Resource Constraints**:
    - **CPU**: 2 vCPUs (ARM/x86).
    - **RAM**: Initially limited (2GB), necessitating aggressive `dbcache` management.
    - **Disk I/O**: Observed high latency during the final 3% of blockchain verification.

#### Sync Acceleration Strategy
At height 269,149, the node experienced significant performance degradation. To resolve this, I performed a technical deep-dive into Bitcoin Core resource management:
- **Optimization Strategy**: Retrieved historical technical discussions ([Bitcointalk Topic 675994](https://bitcointalk.org/index.php?topic=675994.0)) to optimize `dbcache` and resource limits.
- **Vertical Scaling**: Executed a vertical scaling operation, increasing the VPS resource allocation to **4GB RAM**.
- **Refined Memory Management**: Set `dbcache=2500`. By allocating 2.5GB to the database cache, the node keeps the "chainstate" almost entirely in RAM, minimizing slow disk I/O operations.
- **Controlled Execution**: Maintained `par=1` (script verification threads). This ensures that while database operations are accelerated by the cache, the CPU remains stable and does not overwhelm the host instance's resources.

#### Log Evidence: Performance Transition
The difference in timing is considerable when comparing early disk-bound validation to the new high-performance configuration:

**Recent Logs: High-Performance Verification (Block 270,415+)**
```text
2026-03-07T08:33:11Z UpdateTip: ... height=270411 ... progress=0.987901
2026-03-07T08:33:11Z UpdateTip: ... height=270412 ... progress=0.987903
2026-03-07T08:33:11Z UpdateTip: ... height=270413 ... progress=0.987903
...
2026-03-07T08:33:21Z UpdateTip: ... height=270644 ... progress=0.988025
2026-03-07T08:33:21Z UpdateTip: ... height=270645 ... progress=0.988026
```
**Empirical Result**: The node transitioned from taking minutes per block to processing **1 block every 1-2 seconds** (Current Status: 98.80% complete).

### 1.3 Configuration Optimization (Tuning for VPS)
The following [bitcoin.conf](/assets/bitcoin.conf) optimizations were implemented to balance storage efficiency with rapid validation speed:

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| `dbcache` | 2500 | Increased from 450 to 2500 to keep "chainstate" in RAM and eliminate disk I/O bottlenecks. |
| `par` | 1 | Restricted to 1 thread for CPU stability and to avoid saturating host resources during rapid validation. |
| `prune` | 1000 | Essential for Oracle’s ~50GB boot volumes; maintains full security while discarding old block data. |
| `zmq` | Enabled | Rawblock/rawtx interfaces enable real-time LND notifications. |

### 1.4 Technical Summary of Pruning (Reference v0.11.0)
My implementation was guided by the [Bitcoin Core v0.11.0 Release Notes](https://bitcoincore.org/en/releases/0.11.0/) retrieved from the previously mentioned discussion ([Bitcointalk Topic 675994](https://bitcointalk.org/index.php?topic=675994.0)). Pruning allows the node to verify all transactions and maintain a full UTXO set and block index while discarding old raw block data once validated. By combining this with the 4GB RAM/2500MB `dbcache` scaling, I tried to create a high-performance environment that balances absolute security with strict storage constraints.

### 1.5 Cloud Firewalls
Oracle VCN requires separate Ingress Rules for port 10009 (gRPC) and 9735 (P2P), using the Oracle Cloud Console.

## 2. Engineering Task: Liquidity Inspector & Payment Orchestrator

The core software is a NestJS-based application implementing a liquidity inspector and payment orchestrator via REST API that interacts with LND via the gRPC interface.

### Technical Implementation

- **Liquidity Inspector**: Fetches all open channels and computes the Outbound Liquidity Ratio ($Local / Capacity$) and Inbound Liquidity Ratio ($Remote / Capacity$). This provides a real-time health check of "Spendable" vs "Receivable" funds.
- **Invoice Generator**: Allows creation of BOLT11 invoices. This is a component for the orchestrator to request payments and test inbound liquidity flows.
- **Feasibility Engine**: Validates payment requests by comparing the target amount against the largest available balance on any single channel. It distinguishes between insufficient total balance and insufficient channel balance.
- **Automated Orchestrator**: Executes payments using `pay`. It captures cryptographic preimages on success and specific gRPC error codes on failure.
- **Audit Logging**: Every payment attempt is persisted to a structured [payment-logs.json](payment-logs.json) file in order to analyze the payment attempts.
    - **Fee Precision**: For payment logs, I used the `safe_fee` parameter from the [ln-service#pay](https://github.com/alexbosworth/ln-service#pay) request. Unlike the standard `fees` field, which truncates values (e.g., 1.3 sats becomes 1), `safe_fee` rounds up to the nearest satoshi (e.g., 1.3 sats becomes 2). This ensures a more reliable and conservative estimate of costs.
    - **High-Resolution Data**: For maximum precision, `fee_mtokens` (millisatoshis) is also logged, providing the most exact source of truth for routing costs.

### How to Run

1.  **ENVIRONMENT Variables**:
    ```bash
    cp .env.example .env
    ```
    Edit the .env file with environment variables.
2.  **Install dependencies**:
    ```bash
    yarn install
    ```
3.  **Start the orchestrator**:
    ```bash
    yarn start
    ```
4. **Call the REST APIs**: connect directly via the /api where can be found the Swagger Documentation

## 3. Liquidity Experiment

This section documents a series of concrete experiments conducted on a live Signet LND node to demonstrate the directional constraints and behavior of Lightning liquidity.

### Experiment 1: The Inbound Liquidity Trap
**Objective**: Demonstrate that a channel with 100% local balance cannot receive funds.

#### 1.1 Initial State
We observe three newly opened channels where 1,000,000 sats are pushed to the local side.

```bash
docker exec -it lnd-signet lncli --network signet listchannels
```

**Output (Truncated)**:
```json
{
    "channels": [
        {
            "chan_id": "324098644475904000",
            "remote_pubkey": "022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e",
            "capacity": "1000000",
            "local_balance": "999056",
            "remote_balance": "0",
            "unsettled_balance": "0",
            "peer_alias": "022b9e44b3a8093d9512"
        },
        {
            "channelId": "294866x42x0",
            "partnerPublicKey": "0285de109f8f5e401e028fbe0d4241339110752e08d5e8432c937d7c571eeee258", # lnd2-signet
            "localBalance": 998056,
            "remoteBalance": 1000,
            "capacity": 1000000,
            "outboundLiquidityRatio": 0.998056,
            "inboundLiquidityRatio": 0.001,
            "status": "OK"
        },
        {
            "chan_id": "324098644475838464",
            "remote_pubkey": "037414fe3dcfedc4a0a0e153205d9a973af5096d1cd1c8c53d07ed12d7dd966f19",
            "capacity": "1000000",
            "local_balance": "999056",
            "remote_balance": "0",
            "unsettled_balance": "0",
            "peer_alias": "lndwr0-signet.dev.zaphq.io"
        }
    ]
}
```

#### 1.2 Action: Attempting to Receive
We generate a BOLT11 invoice on our main node (`lnd-signet`) for 500,000 sats.

```bash
docker exec -it lnd-signet lncli --network signet addinvoice --amt 500000
```

**Result (Invoice Created)**:
```json
{
    "r_hash": "337c3a2448e536a402c2dc9e7441764f53ef684c268a067787cb1b22c71be957",
    "payment_request": "lntbs5m1p567xwepp5xd7r5fzgu5m2gqkzmj08gstkfaf776zvy69qvau8evdj93cma9tsdqqcqzzsxqyz5vqsp5pvpsd67gctdacuu5p2mt9p0mve55rjkqvq2sgz5yh5s5epw7tlaq9qyyssqazt0npllsl4nqguanz3rqlest799yfr3rftefmzjg4get5x907zyxw80l08n07l8su6gl8jx7ysqpx0x4u7mlcy052w73xt442e366qqlns2av",
    "add_index": "3",
    "payment_addr": "0b0306ebc8c2dbdc73940ab6b285fb666941cac06015040a84bd214c85de5ffa"
}
```
The invoice is successfully generated. To test the receipt of funds, we attempt to pay this invoice **from our second node** (`lnd2-signet`) which is connected via a fresh channel.

**Result (Payment Failure)**:
```text
Payment hash: 337c3a2448e536a402c2dc9e7441764f53ef684c268a067787cb1b22c71be957
Amount (in satoshis): 500000
Payment status: FAILED, reason: FAILURE_REASON_INSUFFICIENT_BALANCE
[lncli] FAILED
```
This fails because while we have a valid "lock" (the invoice), the "pipe" (channel) has only **1000 sats** of **Inbound Liquidity (Remote Balance)** in the channel with `lnd2-signet`.

#### 1.3 Synthesis: Why did "addinvoice" work but payment would fail?
1.  **The Invoice (The Lock)**: `addinvoice` is just a local database entry. It proves our node's crypto is fine.
2.  **The Liquidity (The Pipe)**: A payment requires a "physical" path. As seen in the state, our `remote_balance` is only **1000 sats** in this specific channel. From `lnd2-signet`'s perspective, it lacks the **Spendable Balance** to send towards us.

*As in an Abacus, if all the beads are on the left side (Local Balance), you cannot receive more beads from the right until you first move some beads over to that side.*

---

### Experiment 2: Liquidity Rebalancing (The Shift)
**Objective**: Demonstrate how sending funds creates capacity to receive.

#### 2.1 Action: Send 200,000 Sats
We send a payment to the peer to "push" liquidity to their side using the `--keysend` flag.

```bash
docker exec -it lnd-signet lncli --network signet sendpayment --dest=022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e --amt=200000 --final_cltv_delta=144 --keysend
```

**Output**: `SUCCEEDED`.

#### 2.2 Final State
```json
{
    "chan_id": "324098644475904000",
    "local_balance": "799056",
    "remote_balance": "200000",
    "peer_alias": "022b9e44b3a8093d9512"
}
```

#### 2.3 Synthesis
By sending 200k sats, we successfully "purchased" 200k sats of **Inbound Liquidity**. We can now receive up to 200,000 sats on this channel.

#### 2.4 Experiment: The Keysend Failure Case
Not every node can receive keysend payments. When I tried to send 200,000 sats to `lndwr0-signet.dev.zaphq.io`, it failed with `INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS` because the receiver did not have Spontaneous Payments enabled.

## 4. Setup Instructions (Clean Machine)

1.  **Infrastructure**: Deploy Docker & Docker Compose on an Oracle Linux VPS.
2.  **Bitcoin**: Configure [bitcoin.conf](/assets/bitcoin.conf) with ZMQ enabled and applied optimizations (see [Section 1.3](#13-configuration-optimization-tuning-for-vps)). 
    > [**NOTE**]
    > The `signet=1` flag is forced directly in the Docker container's execution command/entrypoint and not in the `bitcoin.conf` file. This ensures the node is locked to the correct network at the infrastructure level.
3.  **LND**: Initialize wallet, secure `admin.macaroon`, and configure [lnd.conf](/assets/lnd.conf) with `rpclisten=0.0.0.0:10009` and ensure the external IP `<public_ip>:10009` is properly mapped/advertised for RPC access.
4.  **Credentials**: Transfer `tls.cert` and `admin.macaroon` to the credentials directory of the application.
5.  **Execution**: 
    - Launch the NestJS app: `yarn start`.
    - **Verify Connection**: Trigger `GET /lnd/info`.
    - **Request Payment**: Trigger `POST /lnd/invoice` with `{ "amount": 1000, "description": "test" }` to generate a BOLT11.
    - **Execute Payment**: Trigger `POST /lnd/pay` with the generated BOLT11 to test the orchestrator.

## 5. Network Connectivity & Peering

To ensure the node was properly integrated into the Signet Lightning Network, I established connections with two primary peers to facilitate experimentation:

- **Active Sync Node**: `022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e` ([Mempool](https://mempool.space/signet/lightning/node/022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e))
  - Connection Command: `docker exec -it lnd-signet lncli --network signet connect 022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e@44.241.178.65:9735`
- **Zap Node**: `037414fe3dcfedc4a0a0e153205d9a973af5096d1cd1c8c53d07ed12d7dd966f19` ([Mempool](https://mempool.space/signet/lightning/node/037414fe3dcfedc4a0a0e153205d9a973af5096d1cd1c8c53d07ed12d7dd966f19))
  - Connection Command: `docker exec -it lnd-signet lncli --network signet connect 037414fe3dcfedc4a0a0e153205d9a973af5096d1cd1c8c53d07ed12d7dd966f19@35.227.88.87:9735`

### 5.1 On-Chain Funding & Faucet Strategy

> [**NOTE**]
> Obtaining Signet liquidity was the primary hurdle. Most public faucets are inactive, and finding reliable sources required extensive research discovering the [Bitcoin Wiki](https://en.bitcoin.it/wiki/Signet#Faucets) through which I identified the few working options (like the [Hood Scan Faucet](https://faucet.hoodscan.io/)). To accelerate the process, I generated multiple addresses and funneled funds through the internal Bitcoin node before final injection into the Lightning network:

1.  **Initial LN Transaction**: [fc7cbf...c025 (Mempool)](https://mempool.space/signet/tx/fc7cbf33c88a2a5e03fcdb0445ef9505b9d7b50643d20f47c6853e4a8f51c025) — First transaction initiated on the Lightning Network.
2.  **Multi-Address Bitcoin Injection**: Directed faucet funds to the generated multiple addresses and on the internal Bitcoin node (e.g., [27e021...47d6 (Mempool)](https://mempool.space/signet/tx/27e0211a74ed02ddb033ad3b249f16965918878b0c4a407413e2294ae4af47d6)) to bypass cooldowns and aggregate liquidity.
3.  **Bitcoin-to-Lightning Transfer**: Executed an internal transfer from the Bitcoin node wallet to the LND node ([8f7d6e...668 (Mempool)](https://mempool.space/signet/tx/8f7d6ee902fcbb5946c700e63f796ee0f6362582a9fb39a50b269d98e776a668)) to finalize the local balance setup.

#### Final Wallet Status
After multiple transactions, the final state with a total balance of 343,554,023 sats was verified via `lncli walletbalance`:
```json
{
    "total_balance": "343554023",
    "confirmed_balance": "343554023",
    "unconfirmed_balance": "0",
    "locked_balance": "0",
    "reserved_balance_anchor_chan": "20000",
    "account_balance": {
        "default": {
            "confirmed_balance": "343554023",
            "unconfirmed_balance": "0"
        }
    }
}
```

### 5.2 Initial Channel Creation (Zap & Active Sync)
After establishing local liquidity, I opened channels to key peers:

#### Step 1: Zap Node
- **Funding Transaction**: [d266f2...4691a45b (Mempool)](https://mempool.space/signet/tx/d266f2481f019835b94778b9f4648f6d59e64a6e0fbd8e4cbce53d584691a45b)
- **Opening Command**:
  ```bash
  docker exec -it lnd-signet lncli --network signet openchannel \
    --node_key 037414fe3dcfedc4a0a0e153205d9a973af5096d1cd1c8c53d07ed12d7dd966f19 \
    --local_amt 1000000 \
    --sat_per_vbyte 1 \
    --channel_type anchors
  ```

#### Step 2: Active Sync Node
- **Funding Transaction**: [d769e5...3d8f44fa (Mempool)](https://mempool.space/signet/tx/d769e503d403b158f1f728d9296acfafd98dd2e45712c804557bb17d3d8f44fa)
- **Opening Command**:
  ```bash
  docker exec -it lnd-signet lncli --network signet openchannel \
    --node_key 022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e \
    --local_amt 1000000 \
    --sat_per_vbyte 1 \
    --channel_type anchors
  ```

#### Step 3: Third Testing Node (Orchestrator Validation)
To reliably test the `payRequest()` method without self-payments, a third node was introduced to the cluster.
- **Channel Transaction**: A new channel creation between the nodes [e1af69... (Mempool)](https://mempool.space/signet/tx/e1af69313b3856624468b07d08331b6ae88b46c04caaac0e40de9fda4ecbd9a8)
- **Pending Channel Status**:
  ```json
  {
      "pending_open_channels": [
          {
              "channel": {
                  "remote_node_pub": "0285de109f8f5e401e028fbe0d4241339110752e08d5e8432c937d7c571eeee258",
                  "capacity": "1000000",
                  "local_balance": "999056",
                  "remote_balance": "0"
              },
              "commit_fee": "284"
          }
      ]
  }
  ```

## 6. REST API Response Examples

The orchestrator provides a RESTful interface for interacting with the LND node. Below are example responses for key endpoints.

### 6.1 Node Information (`GET /lnd/info`)
```json
{
  "chains": ["f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000"],
  "color": "#3399ff",
  "active_channels_count": 2,
  "alias": "029a3d7cb24221b068e8",
  "current_block_hash": "000000112468a3f1df23b4303a939e80715dd6db4fae371c654c0ec8ec1f787c",
  "current_block_height": 294854,
  "is_synced_to_chain": true,
  "is_synced_to_graph": true,
  "peers_count": 2,
  "public_key": "029a3d7cb24221b068e887ead047b16fea3c5533acedda2bfbc56b370d8478dd89",
  "version": "0.17.0-beta commit=v0.17.0-beta"
}
```

### 6.2 Liquidity Report (Initial State - `GET /lnd/liquidity`)
Initially, both channels exhibit **0 Inbound Liquidity** leading to a `STUCK` status for receiving.
```json
[
  {
    "channelId": "294766x44x0",
    "partnerPublicKey": "022b9e44b3a8093d9512b61f5f83a72d5634201efc49718efd34f2ee851b3afa8e",
    "localBalance": 999056,
    "remoteBalance": 0,
    "capacity": 1000000,
    "outboundLiquidityRatio": 0.999056,
    "inboundLiquidityRatio": 0,
    "status": "STUCK"
  },
  {
    "channelId": "294766x43x0",
    "partnerPublicKey": "037414fe3dcfedc4a0a0e153205d9a973af5096d1cd1c8c53d07ed12d7dd966f19",
    "localBalance": 999056,
    "remoteBalance": 0,
    "capacity": 1000000,
    "outboundLiquidityRatio": 0.999056,
    "inboundLiquidityRatio": 0,
    "status": "STUCK"
  }
]
```

### 6.3 Payment Feasibility (`GET /lnd/feasibility?amount=...`)

**Scenario: Large Amount (Failure)**
```json
{
  "targetAmountSats": 10000000,
  "canSend": false,
  "sendExplanation": "Node cannot send 10000000 sats. Max outbound on any single channel is 999056 sats.",
  "canReceive": false,
  "receiveExplanation": "Node cannot receive 10000000 sats. Max inbound on any single channel is 0 sats."
}
```

**Scenario: Valid Amount (Success)**
```json
{
  "targetAmountSats": 100000,
  "canSend": true,
  "sendExplanation": "Node can send 100000 sats because a channel has outbound capacity of 999056 sats.",
  "canReceive": false,
  "receiveExplanation": "Node cannot receive 100000 sats. Max inbound on any single channel is 0 sats."
}
```

### 6.4 Successful Orchestration Results (`POST /lnd/pay`)
After introducing a new testing lnd node on the Oracle VPS, the orchestrator successfully confirmed the liquidity transition and node statistics.

#### Step-by-Step Validation Process:
1.  **Node Expansion**: A new node (`0285de109f8f5e401e028fbe0d4241339110752e08d5e8432c937d7c571eeee258`) was created via Docker to bypass the problem of having an invoice from an unkown peer.
2.  **Channel Establishment**: A new channel was opened between the main node and the test node. During this phase, the orchestrator correctly identified the **pending status**:
    ```json
    {
      "active_channels_count": 2,
      "pending_channels_count": 1,
      "peers_count": 3
    }
    ```
3.  **Payment Orchestration**: An invoice was generated on the new node (`lnd2-signet`) and paid via the REST API (`POST /lnd/pay`).
    ```bash
    docker exec -it lnd2-signet lncli --network signet addinvoice --amt 1000 --memo "test payRequest"
    ```
    **Invoice Output**:
    ```json
    {
        "r_hash": "c3728a4665e69bb5cc3690f35490704cb5401aa4d92d804f3ab01874315ea487",
        "payment_request": "lntbs10u1p5679x6pp5cdeg53n9u6dmtnpkjre4fyrsfj65qx4ymykcqne6kqv8gv275jrsdqcw3jhxapqwpshj5n9w96k2um5cqzzsxqyz5vqsp50vsx9lr07dffsdgp4agqus5dcnr4w2k2ak6dj35xmpdszuhlk7fq9qyyssq39mt4xpzrvxafxs338dc876clkcksgq0hr22jk4n5zdk7v66jfwnvphy9ddts6nnuctpt3rkp8qhng3jj50sc9kmkh5hkfaqw6sta5spm8a8m5",
        "add_index": "1",
        "payment_addr": "7b2062fc6ff352983501af500e428dc4c7572acaedb4d94686d85b0172ffb792"
    }
    ```

    **API Response (`POST /lnd/pay`)**:
    ```json
    {
      "success": true,
      "paymentRequest": "lntbs10u1p5679x6pp5cdeg53n9u6dmtnpkjre4fyrsfj65qx4ymykcqne6kqv8gv275jrsdqcw3jhxapqwpshj5n9w96k2um5cqzzsxqyz5vqsp50vsx9lr07dffsdgp4agqus5dcnr4w2k2ak6dj35xmpdszuhlk7fq9qyyssq39mt4xpzrvxafxs338dc876clkcksgq0hr22jk4n5zdk7v66jfwnvphy9ddts6nnuctpt3rkp8qhng3jj50sc9kmkh5hkfaqw6sta5spm8a8m5",
      "preimage": "84684ca01f8cd7b99b20835a5baa4c65e8d1e0d3d3e86079f21269e536865320",
      "feeSats": 0,
      "fee_mtokens": "0",
      "channels": [
        {
          "channelId": "294866x42x0",
          "fee_mtokens": "0"
        }
      ],
      "details": {
        "destination": "0285de109f8f5e401e028fbe0d4241339110752e08d5e8432c937d7c571eeee258",
        "amount": 1000
      }
    }
    ```
4.  **Liquidity Verification**: Following the payment, the orchestrator successfully tracked the balance shifts. The newly created testing channel shows successful inbound liquidity:
  
    ```json
    {
        "channelId": "294866x42x0",
        "partnerPublicKey": "0285de109f8f5e401e028fbe0d4241339110752e08d5e8432c937d7c571eeee258",
        "localBalance": 998056,
        "remoteBalance": 1000,
        "capacity": 1000000,
        "outboundLiquidityRatio": 0.998056,
        "inboundLiquidityRatio": 0.001,
        "status": "OK"
    }
    ```

## 7. Development Log & Timeline

- **Infrastructure Setup**: 4 hours (Oracle Cloud VCN, Docker orchestration, and security group/firewall configuration).
- **Blockchain Synchronization**: 18 hours (Initial sync on Signet, including vertical scaling to 4GB RAM and `dbcache` optimization).
- **Liquidity Acquisition (Faucets)**: 6 hours (Researching active Signet faucets, managing cooldowns, and aggregating funds across multiple addresses).
- **Logic Development**: 8 hours (NestJS architecture, gRPC implementation, structured logging, and feasibility engine).
- **Experimentation & Verification**: 2 hours (Conducting rebalancing experiments, debugging keysend failure cases, and validating via 3-node cluster).
- **TOTAL**: 20 hours + 18 hours (Sync) = 38 hours

---
